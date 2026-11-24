import { onCall, onRequest } from 'firebase-functions/v2/https';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { setGlobalOptions } from 'firebase-functions/v2/options';
import admin from 'firebase-admin';

admin.initializeApp();

import { REGION } from './env';
import { dispatch } from './dispatch';
import * as utils from './lib/utils';
import * as user from './lib/user';
import * as group from './lib/group';
import { PERMISSIONS } from './lib/permissions';
import * as crm from './lib/crm/index';
import { CONTACT_TYPES, type ContactType } from './lib/crm/config';
import * as automations from './lib/automations/index';
import * as connections from './lib/connections/index';
import * as reports from './lib/reports/index';
import * as health from './lib/health/index';
import * as claude from './lib/mcp/index';

setGlobalOptions({ maxInstances: 10, region: REGION });

/** Shared secret the website forms send in `x-flf-token`. */
const leadWebhookToken = defineSecret('LEAD_WEBHOOK_TOKEN');
/** Slack Incoming Webhook URL of the team channel. */
const slackWebhookUrl = defineSecret('SLACK_WEBHOOK_URL');
/** Signs the Claude connector's clients and tokens and seals its keys (docs/claude-connector.md). */
const flfMcpKey = defineSecret('FLF_MCP_KEY');

const userLogger = utils.createLogger('user');
const webhookLogger = utils.createLogger('crm').scope('webhook');

/** Secrets for connection checks, read only inside handlers that declared them. */
const secrets = (): connections.Secrets => ({
	slackWebhookUrl: slackWebhookUrl.value() || undefined,
	leadWebhookToken: leadWebhookToken.value() || undefined
});

/*
 * EVERY callable is one `<feature>Action` dispatcher (see dispatch.ts). Add an action to the
 * right dispatcher, never a new export; only non-callable triggers are their own function.
 */

export const coreAction = onCall(
	{ secrets: [flfMcpKey] },
	dispatch('core', {
		/** Who the signed-in user is and what they may do; creates their user document on first sign-in. */
		'user.validate': {
			handler: async (_p, auth) => {
				const u = await user.getOrCreate(auth);
				// The Firestore rules read the role claim. syncUserRole writes it later, after the
				// client has already refreshed its token, so write it here when it is missing or stale.
				if (auth.token.role !== u.role) {
					await admin.auth().setCustomUserClaims(auth.uid, { role: u.role });
				}
				const valid = u.role !== 'guest';
				return {
					valid,
					role: u.role,
					permissions: valid ? await user.permissionsOf(u.groups ?? []) : []
				};
			}
		},
		/** Every permission a group can grant, for Admin → Groups. */
		'config.get': { adminOnly: true, handler: async () => ({ permissions: PERMISSIONS }) },
		/** Change a user's role, groups and Sherpa flag. */
		'user.update': {
			adminOnly: true,
			handler: async (p) => {
				await user.updateAccess(
					utils.str(p.uid, 'uid'),
					utils.oneOf(p.role, ['guest', 'user', 'admin'] as const, 'role'),
					Array.isArray(p.groups) ? p.groups.map(String) : [],
					p.sherpa === true
				);
				return { ok: true };
			}
		},
		/** Create or update a group. */
		'group.save': {
			adminOnly: true,
			handler: async (p) => ({
				id: await group.save(
					p.id ?? null,
					utils.str(p.name, 'name'),
					utils.str(p.description, 'description', false),
					Array.isArray(p.permissions) ? p.permissions : []
				)
			})
		},
		/** Delete a group and take it off its members. */
		'group.remove': {
			adminOnly: true,
			handler: async (p) => {
				await group.remove(utils.str(p.id, 'id'));
				return { ok: true };
			}
		},
		/** The Claude consent page: which app asks and where it sends you back. Writes nothing. */
		'claude.client': {
			handler: async (p) => claude.describeClient(claude.keys(flfMcpKey.value()), p)
		},
		/** Approve a Claude connection: a fresh sign-in and `claude.self.connect` required. */
		'claude.approve': {
			handler: async (p, auth) => claude.approveClient(claude.keys(flfMcpKey.value()), p, auth)
		},
		/** Your own Claude connections, and the address to connect with. */
		'claude.connections': {
			handler: async (_p, auth) => {
				const { rows, more } = await claude.connections.own(auth);
				return { connections: rows, more, connectorUrl: claude.CONNECTOR_URL };
			}
		},
		/** End one of your own Claude connections at once. */
		'claude.disconnect': {
			handler: async (p, auth) => claude.connections.end(p.id, auth)
		},
		/** Every Claude connection in the team, newest first. */
		'claude.admin.list': { adminOnly: true, handler: async () => claude.connections.all() },
		/** End anyone's Claude connection. */
		'claude.admin.revoke': {
			adminOnly: true,
			handler: async (p) => claude.connections.revoke(p.id)
		}
	})
);

const crmWrite = { permission: 'crm.any.write', denied: 'You cannot edit the CRM.' };
export const crmAction = onCall(
	dispatch('crm', {
		/** Contact types, sources and each type's pipeline. */
		'config.get': { permission: 'crm.any.read', handler: crm.actions['config.get'] },
		/** Add a contact in its pipeline's first stage. */
		'contact.create': { ...crmWrite, handler: crm.actions['contact.create'] },
		/** Edit a contact's details. */
		'contact.update': { ...crmWrite, handler: crm.actions['contact.update'] },
		/** Move a contact to another stage of its pipeline. */
		'contact.stage': { ...crmWrite, handler: crm.actions['contact.stage'] },
		/** Give a contact an owner, or none. */
		'contact.assign': { ...crmWrite, handler: crm.actions['contact.assign'] },
		/** Delete a contact, its timeline and its tasks. */
		'contact.delete': {
			permission: 'crm.any.delete',
			denied: 'You cannot delete contacts.',
			handler: crm.actions['contact.delete']
		},
		/** Add a note to a contact's timeline. */
		'note.add': { ...crmWrite, handler: crm.actions['note.add'] },
		/** Create a task on a contact. */
		'task.create': { ...crmWrite, handler: crm.actions['task.create'] },
		/** Mark a task done or not done. */
		'task.done': { ...crmWrite, handler: crm.actions['task.done'] }
	})
);

export const reportsAction = onCall(
	{ timeoutSeconds: 120 },
	dispatch('reports', {
		/** Pipeline funnel, sources and KPIs from the CRM. */
		summary: { permission: 'reports.any.read', handler: reports.actions.summary },
		/** The Google Sheets copied by the nightly sync. */
		'sheets.list': { permission: 'reports.any.read', handler: reports.actions['sheets.list'] }
	})
);

export const automationsAction = onCall(
	dispatch('automations', {
		/** Every automation the Hub runs. */
		'config.get': {
			permission: 'automations.any.read',
			handler: automations.actions['config.get']
		},
		/** Turn an automation on or off. */
		toggle: { permission: 'automations.any.write', handler: automations.actions.toggle }
	})
);

const connectionActions = connections.actionsWith(secrets);
export const connectionsAction = onCall(
	{ secrets: [slackWebhookUrl, leadWebhookToken], timeoutSeconds: 300 },
	dispatch('connections', {
		/** Every connection, what it feeds and how to set it up. */
		'config.get': { permission: 'connections.any.read', handler: connectionActions['config.get'] },
		/** Save a connection's non-secret settings. */
		'settings.save': {
			permission: 'connections.any.write',
			handler: connectionActions['settings.save']
		},
		/** Check a connection now and record the result. */
		test: { permission: 'connections.any.read', handler: connectionActions.test },
		/** Copy the configured Google Sheets now. */
		'sheets.sync': {
			permission: 'connections.any.write',
			handler: connectionActions['sheets.sync']
		},
		/** Connections, automations and data freshness in one list. */
		'health.get': { permission: 'health.any.read', handler: async () => health.get() }
	})
);

/** Mirror `user/{uid}.role` into the Auth custom claim the rules and UI read. */
export const syncUserRole = onDocumentWritten('user/{uid}', async (event) => {
	if (!event.data?.after?.exists) return;
	const role = event.data.after.data()?.role || 'guest';
	const before = event.data.before?.exists ? event.data.before.data()?.role : null;
	if (before === role) return;
	await admin.auth().setCustomUserClaims(event.params.uid, { role });
	userLogger.log(`${event.params.uid} role set to ${role}`);
});

/** Runs the contact automations on create and on stage change. */
export const crmContactWritten = onDocumentWritten(
	{ document: 'contact/{id}', secrets: [slackWebhookUrl] },
	async (event) => {
		const after = event.data?.after;
		if (!after?.exists) return;
		const c = after.data() as crm.Contact;
		const before = event.data?.before?.exists ? (event.data.before.data() as crm.Contact) : null;
		if (!before) {
			await automations.onContactCreated(event.params.id, c, slackWebhookUrl.value() || undefined);
		} else if (before.stage !== c.stage) {
			await automations.onStageChanged(event.params.id, c);
		}
	}
);

/**
 * Website form endpoint. POST JSON with header `x-flf-token`. Creates the contact, or adds a note
 * to the existing one when the email is already known.
 */
export const crmLeadWebhook = onRequest(
	{ secrets: [leadWebhookToken], cors: true },
	async (req, res) => {
		if (req.method !== 'POST') {
			res.status(405).send('POST only');
			return;
		}
		if (!leadWebhookToken.value() || req.get('x-flf-token') !== leadWebhookToken.value()) {
			res.status(401).send('Unauthorized');
			return;
		}
		const b = req.body ?? {};
		const type = String(b.type ?? '').toLowerCase();
		if (!(CONTACT_TYPES as readonly string[]).includes(type) || !b.name || !b.email) {
			res.status(400).send('type, name and email are required');
			return;
		}
		try {
			const existing = await crm.findByEmail(String(b.email));
			let id: string;
			if (existing) {
				id = existing.id;
				await crm.logActivity(
					id,
					'note',
					`Sent the ${type} form again${b.message ? `: ${b.message}` : ''}`,
					'Website'
				);
			} else {
				id = await crm.create(
					{ ...b, type: type as ContactType, source: 'website', notes: b.message ?? '' },
					'Website',
					'website'
				);
			}
			await connections.touchEvent('website-forms');
			res.status(200).json({ ok: true, id });
		} catch (err) {
			webhookLogger.error('lead failed', err);
			res.status(500).send('Error');
		}
	}
);

/** Every morning: stale contacts, the digest, and the Claude connector's expired records. */
export const automationsDaily = onSchedule(
	{ schedule: '0 8 * * *', timeZone: 'Europe/Madrid', secrets: [slackWebhookUrl] },
	async () => {
		const url = slackWebhookUrl.value() || undefined;
		await automations.staleContacts(url);
		await automations.dailyDigest(url);
		const cleaned = await claude.cleanUp();
		utils.createLogger('claude-connector').log(`clean-up ${JSON.stringify(cleaned)}`);
	}
);

/**
 * The Claude connector (docs/claude-connector.md): OAuth (the Hub is the issuer), the discovery
 * documents and MCP over streamable HTTP, stateless. Claude acts as the signed-in person.
 */
export const claudeMcp = onRequest(
	{
		// The tools run other dispatchers' actions (connections:test reads Slack and the lead token),
		// so the connector holds those secrets too.
		secrets: [flfMcpKey, slackWebhookUrl, leadWebhookToken],
		timeoutSeconds: 60,
		memory: '512MiB',
		cpu: 1,
		concurrency: 40,
		maxInstances: 5
	},
	async (req, res) => {
		await claude.handle(
			req as unknown as Parameters<typeof claude.handle>[0],
			res as unknown as Parameters<typeof claude.handle>[1],
			claude.keys(flfMcpKey.value())
		);
	}
);

/** Every night: copy Google Sheets for Reports. */
export const sheetsNightly = onSchedule(
	{ schedule: '0 3 * * *', timeZone: 'Europe/Madrid', timeoutSeconds: 300 },
	async () => automations.sheetsSync()
);

/** Every hour: check every connection so Health is current. */
export const healthHourly = onSchedule(
	{
		schedule: 'every 60 minutes',
		secrets: [slackWebhookUrl, leadWebhookToken],
		timeoutSeconds: 300
	},
	async () => connections.testAll(secrets())
);
