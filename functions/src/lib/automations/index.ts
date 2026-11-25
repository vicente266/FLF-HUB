import { HttpsError } from 'firebase-functions/v2/https';
import { db } from '../../firestore';
import { serverTimestamp, increment, str, createLogger, Timestamp } from '../utils';
import * as crm from '../crm/index';
import { MEETING_STAGES, nextStepOf, stageOf, STALE_DAYS, type ContactType } from '../crm/config';
import * as connections from '../connections/index';
import { AUTOMATIONS, N8N_AUTOMATIONS, automation } from './config';

const logger = createLogger('automations');
export const collection = db.collection('automation');
export const runs = db.collection('automationRun');

const DAY = 24 * 60 * 60 * 1000;

async function enabled(id: string): Promise<boolean> {
	const doc = await collection.doc(id).get();
	const value = doc.data()?.enabled;
	return typeof value === 'boolean' ? value : (automation(id)?.defaultEnabled ?? false);
}

/** Run one automation if it is on, recording the outcome. Never throws. */
export async function run(
	id: string,
	body: () => Promise<string | null>,
	contactId: string | null = null
): Promise<void> {
	if (!(await enabled(id))) return;
	try {
		const result = await body();
		if (result === null) return; // nothing to do — not a run
		await Promise.all([
			collection
				.doc(id)
				.set(
					{ lastRunAt: serverTimestamp(), runs: increment(1), lastError: null },
					{ merge: true }
				),
			runs.add({ automationId: id, contactId, result, ok: true, at: serverTimestamp() })
		]);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.error(`${id} failed`, err);
		await Promise.all([
			collection
				.doc(id)
				.set(
					{ lastRunAt: serverTimestamp(), lastError: message, errors: increment(1) },
					{ merge: true }
				),
			runs.add({ automationId: id, contactId, result: message, ok: false, at: serverTimestamp() })
		]);
	}
}

async function addTask(
	contactId: string,
	contactName: string,
	uid: string,
	title: string,
	days: number
) {
	await crm.tasks.add({
		contactId,
		contactName,
		title,
		dueAt: Timestamp.fromMillis(Date.now() + days * DAY),
		assigneeUid: uid,
		done: false,
		source: 'automation',
		createdAt: serverTimestamp()
	});
}

/** `contact/{id}` moved to another stage. */
export async function onStageChanged(id: string, c: crm.Contact) {
	await run(
		'stage-follow-up',
		async () => {
			const stage = stageOf(c.type as ContactType, c.stage);
			if (!stage?.followUp || !c.ownerUid) return null;
			await addTask(id, crm.displayName(c), c.ownerUid, stage.followUp, stage.followUpDays ?? 3);
			return `Task "${stage.followUp}" for ${c.ownerName}`;
		},
		id
	);
}

/** `contact/{id}` got another next step (set in the Hub; sheet imports don't fire it). */
export async function onNextStepChanged(id: string, c: crm.Contact) {
	await run(
		'next-step-task',
		async () => {
			const step = nextStepOf(c.nextStep);
			if (!step || !c.ownerUid) return null;
			await addTask(id, crm.displayName(c), c.ownerUid, step.task, step.days);
			return `Task "${step.task}" for ${c.ownerName}`;
		},
		id
	);
}

/** A meeting the portal sync just brought in. */
export interface NewMeeting {
	contactId: string;
	title: string;
	date: Date | null;
}

/**
 * After a sync: for each new, recent meeting with a contact in a stage a meeting can move forward,
 * ask the owner whether to move it. One task per contact per sync.
 */
export async function meetingSuggestions(meetings: NewMeeting[]) {
	const recent = Date.now() - 14 * DAY;
	const latest = new Map<string, NewMeeting>();
	for (const m of meetings) {
		if (!m.date || m.date.getTime() < recent) continue;
		const prev = latest.get(m.contactId);
		if (!prev || (prev.date?.getTime() ?? 0) < m.date.getTime()) latest.set(m.contactId, m);
	}
	for (const m of latest.values()) {
		await run(
			'meeting-next-stage',
			async () => {
				const doc = await crm.contacts.doc(m.contactId).get();
				const c = doc.data() as crm.Contact | undefined;
				// Fellows only: the calendar meetings are with the portal's CRM people.
				if (!c || c.type !== 'fellow' || !c.ownerUid || !MEETING_STAGES.includes(c.stage))
					return null;
				const stage = stageOf(c.type, c.stage)?.label ?? c.stage;
				const day = m.date!.toISOString().slice(0, 10);
				const title = `Met on ${day} (“${m.title}”): move from ${stage} to the next stage?`;
				await addTask(m.contactId, crm.displayName(c), c.ownerUid, title, 1);
				return `Asked ${c.ownerName} about ${crm.displayName(c)}`;
			},
			m.contactId
		);
	}
}

/** Daily: flag open contacts with no activity for STALE_DAYS. */
export async function staleContacts(slackUrl: string | undefined) {
	await run('stale-contacts', async () => {
		const cutoff = Timestamp.fromMillis(Date.now() - STALE_DAYS * DAY);
		const snap = await crm.contacts
			.where('open', '==', true)
			.where('needsAttention', '==', false)
			.where('lastActivityAt', '<', cutoff)
			.limit(200)
			.get();
		if (snap.empty) return null;
		for (const doc of snap.docs) {
			const c = doc.data() as crm.Contact;
			await doc.ref.update({ needsAttention: true });
			if (c.ownerUid)
				await addTask(
					doc.id,
					crm.displayName(c),
					c.ownerUid,
					`No activity for ${STALE_DAYS} days: check in`,
					1
				);
		}
		await connections.slack(
			slackUrl,
			`${snap.size} contacts need attention (no activity for ${STALE_DAYS} days).`
		);
		return `${snap.size} contacts flagged`;
	});
}

/** Daily: Slack summary. */
export async function dailyDigest(slackUrl: string | undefined) {
	await run('daily-digest', async () => {
		if (!slackUrl) return null;
		const since = Timestamp.fromMillis(Date.now() - DAY);
		const endOfDay = Timestamp.fromMillis(Date.now() + DAY);
		const [created, due, stale] = await Promise.all([
			crm.contacts.where('createdAt', '>=', since).count().get(),
			crm.tasks.where('done', '==', false).where('dueAt', '<=', endOfDay).count().get(),
			crm.contacts.where('open', '==', true).where('needsAttention', '==', true).count().get()
		]);
		await connections.slack(
			slackUrl,
			`*FLF Hub daily*\n• New contacts (24h): ${created.data().count}\n• Tasks due today or overdue: ${due.data().count}\n• Need attention: ${stale.data().count}`
		);
		return 'Digest posted';
	});
}

export async function portalSync() {
	await run('portal-sync', async () => {
		const portal = await import('../portal/index.js');
		const r = await portal.run();
		return `${r.contacts} contacts (${r.created} new, ${r.moved} moved), ${r.tasks} tasks`;
	});
}

export const actions = {
	'config.get': async () => ({ automations: AUTOMATIONS, n8n: N8N_AUTOMATIONS }),

	toggle: async (p: any) => {
		const id = str(p.id, 'id');
		if (!automation(id)) throw new HttpsError('not-found', 'Unknown automation.');
		await collection.doc(id).set({ enabled: p.enabled === true }, { merge: true });
		return { ok: true };
	}
};
