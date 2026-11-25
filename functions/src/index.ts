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
import * as automations from './lib/automations/index';
import * as connections from './lib/connections/index';
import * as reports from './lib/reports/index';
import * as health from './lib/health/index';
import * as claude from './lib/mcp/index';
import * as knowledge from './lib/knowledge/index';
import * as portal from './lib/portal/index';
import * as tv from './lib/tv/index';

setGlobalOptions({ maxInstances: 10, region: REGION });

/** Slack Incoming Webhook URL of the team channel. */
const slackWebhookUrl = defineSecret('SLACK_WEBHOOK_URL');
/** n8n API key, used only to list executions (Health). */
const n8nApiKey = defineSecret('N8N_API_KEY');
/** Signs the Claude connector's clients and tokens and seals its keys (docs/claude-connector.md). */
const flfMcpKey = defineSecret('FLF_MCP_KEY');

/** An optional secret's value; `unset` (Secret Manager can't store an empty value) or blank means not configured. */
const optional = (s: { value(): string }): string | undefined => {
	const v = s.value().trim();
	return v && v !== 'unset' ? v : undefined;
};

const userLogger = utils.createLogger('user');

/** Secrets for connection checks, read only inside handlers that declared them. */
const secrets = (): connections.Secrets => ({
	slackWebhookUrl: optional(slackWebhookUrl),
	n8nApiKey: optional(n8nApiKey)
});
/** Every secret a connection check reads. */
const checkSecrets = [slackWebhookUrl, n8nApiKey];

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
		/** The Knowledge list, active and expired, plus the active block Claude reads. */
		'knowledge.list': { permission: 'knowledge.any.read', handler: knowledge.actions.list },
		/** Add or edit a Knowledge entry. */
		'knowledge.save': { permission: 'knowledge.any.write', handler: knowledge.actions.save },
		/** Delete a Knowledge entry. */
		'knowledge.delete': { permission: 'knowledge.any.write', handler: knowledge.actions.delete },
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
		},
		// FLF TV (docs/flf-tv.md). On coreAction like knowledge.*: see CLAUDE.md, "Add an action".
		/** FLF TV statuses, skill ids and the default brand settings. */
		'tv.config.get': { permission: 'tv.any.read', handler: tv.actions['config.get'] },
		/** Queue a Google Drive video for the Mac worker. */
		'tv.video.add': { permission: 'tv.any.write', handler: tv.actions['video.add'] },
		/** Process a video again (new suggestions replace the old ones). */
		'tv.video.retry': { permission: 'tv.any.write', handler: tv.actions['video.retry'] },
		/** Delete a video, its transcript and its clips (the Drive files stay). */
		'tv.video.delete': { permission: 'tv.any.write', handler: tv.actions['video.delete'] },
		/** Edit a clip's times, hook, caption, hashtags or framing. */
		'tv.clip.update': { permission: 'tv.any.write', handler: tv.actions['clip.update'] },
		/** Approve (to render), reject, or reopen a clip. */
		'tv.clip.status': { permission: 'tv.any.write', handler: tv.actions['clip.status'] },
		/** A skill (Clipping or Brand) as the worker will read it. */
		'tv.skill.get': { permission: 'tv.any.read', handler: tv.actions['skill.get'] },
		/** Save a skill; the next video uses it. */
		'tv.skill.save': { permission: 'tv.any.write', handler: tv.actions['skill.save'] },
		/** Back to the built-in skill. */
		'tv.skill.reset': { permission: 'tv.any.write', handler: tv.actions['skill.reset'] }
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
		/** Set a contact's next step (Plan Interaction, Awaiting for Response), or none. */
		'contact.nextStep': { ...crmWrite, handler: crm.actions['contact.nextStep'] },
		/** Give a contact an owner, or none. */
		'contact.assign': { ...crmWrite, handler: crm.actions['contact.assign'] },
		/** Delete a contact, its timeline and its tasks. */
		'contact.delete': {
			permission: 'crm.any.delete',
			denied: 'You cannot delete contacts.',
			handler: crm.actions['contact.delete']
		},
		/** Create or edit a go-to-market strategy (name, segment, approach, status). */
		'strategy.save': { ...crmWrite, handler: crm.actions['strategy.save'] },
		/** Delete a strategy; its Partners stay, unlinked. */
		'strategy.delete': { ...crmWrite, handler: crm.actions['strategy.delete'] },
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
		summary: { permission: 'reports.any.read', handler: reports.actions.summary }
	})
);

export const automationsAction = onCall(
	{ secrets: [n8nApiKey] },
	dispatch('automations', {
		/** Every automation the Hub runs. */
		'config.get': {
			permission: 'automations.any.read',
			handler: automations.actions['config.get']
		},
		/** Turn an automation on or off. */
		toggle: { permission: 'automations.any.write', handler: automations.actions.toggle },
		/** Every n8n workflow with its status, last run and recent failures (read only). */
		'n8n.workflows': {
			permission: 'automations.any.read',
			handler: async () => ({ workflows: await connections.n8nWorkflows(optional(n8nApiKey)) })
		}
	})
);

const connectionActions = connections.actionsWith(secrets);
export const connectionsAction = onCall(
	{ secrets: checkSecrets, timeoutSeconds: 300 },
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
		/** Connections, automations and data freshness in one list. */
		'health.get': { permission: 'health.any.read', handler: async () => health.get() }
	})
);

export const portalAction = onCall(
	{ timeoutSeconds: 300, memory: '512MiB' },
	dispatch('portal', {
		/** What an import of the portal sheet would write, without writing anything. */
		'sync.plan': { permission: 'connections.any.write', handler: async () => portal.dryRun() },
		/** Import the portal sheet now (read-only on the sheet; upserts in the Hub). */
		'sync.run': { permission: 'connections.any.write', handler: async () => portal.run() },
		/** One Fellow's PERMA history. Health data: its own permission, never via Claude. */
		'wellbeing.get': {
			permission: 'wellbeing.any.read',
			denied: 'Wellbeing data needs its own permission.',
			handler: async (p) => portal.wellbeingOf(utils.str(p.contactId, 'contactId'))
		},
		/** Cohort averages of the latest PERMA: no individual answers. */
		'wellbeing.summary': {
			permission: 'wellbeing.any.read',
			denied: 'Wellbeing data needs its own permission.',
			handler: async () => portal.wellbeingSummary()
		},
		/** One Fellow's income and financial report totals. */
		'finance.get': {
			permission: 'wealth.any.read',
			denied: 'Financial data needs its own permission.',
			handler: async (p) => portal.financeOf(utils.str(p.contactId, 'contactId'))
		}
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

/** Runs the contact automations on stage change and on next-step change. */
export const crmContactWritten = onDocumentWritten('contact/{id}', async (event) => {
	const after = event.data?.after;
	if (!after?.exists) return;
	const c = after.data() as crm.Contact;
	const before = event.data?.before?.exists ? (event.data.before.data() as crm.Contact) : null;
	// The portal import writes `portal.syncedAt`: those writes are copies of the sheet, so no
	// owner assignment, Slack alert or follow-up task fires from them.
	const synced = (x: crm.Contact | null) => (x as any)?.portal?.syncedAt?.toMillis?.();
	if (synced(c) && synced(c) !== synced(before)) return;
	// Created in the Hub: its first stage's follow-up (imports are skipped just above).
	if (!before) return automations.onStageChanged(event.params.id, c);
	if (before.stage !== c.stage) await automations.onStageChanged(event.params.id, c);
	if ((before.nextStep ?? '') !== (c.nextStep ?? ''))
		await automations.onNextStepChanged(event.params.id, c);
});

/** Every morning: stale contacts, the digest, and the Claude connector's expired records. */
export const automationsDaily = onSchedule(
	{ schedule: '0 8 * * *', timeZone: 'Europe/Madrid', secrets: [slackWebhookUrl] },
	async () => {
		const url = optional(slackWebhookUrl);
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
		// The tools run other dispatchers' actions (connections:test reads Slack and n8n),
		// so the connector holds those secrets too.
		secrets: [flfMcpKey, ...checkSecrets],
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

/** Every night: import the portal sheet (read-only on the sheet). */
export const portalNightly = onSchedule(
	{ schedule: '0 3 * * *', timeZone: 'Europe/Madrid', timeoutSeconds: 540, memory: '512MiB' },
	async () => automations.portalSync()
);

/** Every hour: check every connection so Health is current. */
export const healthHourly = onSchedule(
	{
		schedule: 'every 60 minutes',
		secrets: checkSecrets,
		timeoutSeconds: 300
	},
	async () => connections.testAll(secrets())
);
