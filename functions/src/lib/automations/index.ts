import { HttpsError } from 'firebase-functions/v2/https';
import { db } from '../../firestore';
import { serverTimestamp, increment, str, createLogger, Timestamp } from '../utils';
import * as crm from '../crm/index';
import { MEETING_STAGES, nextStepOf, stageOf, STALE_DAYS, type ContactType } from '../crm/config';
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
			collection.doc(id).set(
				{
					lastRunAt: serverTimestamp(),
					lastError: message,
					runs: increment(1),
					errors: increment(1)
				},
				{ merge: true }
			),
			runs.add({ automationId: id, contactId, result: message, ok: false, at: serverTimestamp() })
		]);
	}
}

/**
 * Who an automation's task goes to: the owner, or else whoever last created, moved or set the next
 * step of the contact in the Hub (so a contact without a Sherpa still gets its follow-ups). With
 * neither, no task is made (a stale contact is still flagged "needs attention").
 */
const assigneeOf = (c: crm.Contact) => c.ownerUid || c.changedByUid || null;

/** An automation's task. `automationId` lets a later change close it when it no longer applies. */
async function addTask(
	automationId: string,
	contactId: string,
	c: crm.Contact,
	title: string,
	days: number
) {
	await crm.tasks.add({
		contactId,
		contactName: crm.displayName(c),
		title,
		// The end of that day in Madrid, as for a task added by hand.
		dueAt: Timestamp.fromDate(
			crm.endOfDay(
				new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(
					new Date(Date.now() + days * DAY)
				)
			)
		),
		assigneeUid: assigneeOf(c),
		done: false,
		source: 'automation',
		automationId,
		createdAt: serverTimestamp()
	});
}

/** Display name of whoever a task went to, for the run log. */
const toWhom = (c: crm.Contact) =>
	c.ownerUid ? c.ownerName : c.changedByUid ? c.changedByName : 'nobody (Tasks → Everyone)';

/**
 * `contact/{id}` entered a stage: created in the Hub (its first stage) or moved. Closes the
 * follow-ups of the stage it left, then gives its owner (or whoever moved it) this stage's task.
 */
export async function onStageChanged(id: string, c: crm.Contact) {
	// The current state: with two quick moves, the handler of the first must not act after the second.
	const now = (await crm.contacts.doc(id).get()).data() as crm.Contact | undefined;
	if (!now || now.stage !== c.stage) return;
	// The old stage's tasks close whether or not the follow-up automation is on.
	// A final stage (Fellow, Lost…) also ends the next-step chase.
	const final = !!stageOf(now.type as ContactType, now.stage)?.final;
	const closed = await crm.closeAutomationTasks(id, [
		'stage-follow-up',
		'meeting-next-stage',
		'stale-contacts',
		...(final ? ['next-step-task'] : [])
	]);
	await run(
		'stage-follow-up',
		async () => {
			const stage = stageOf(now.type as ContactType, now.stage);
			if (!stage?.followUp || !assigneeOf(now))
				return closed ? `Closed ${closed} task(s) of the previous stage` : null;
			await addTask('stage-follow-up', id, now, stage.followUp, stage.followUpDays ?? 3);
			return `Task "${stage.followUp}" for ${toWhom(now)}${closed ? `; closed ${closed} old` : ''}`;
		},
		id
	);
}

/** `contact/{id}` got another next step (set in the Hub; sheet imports don't fire it). */
export async function onNextStepChanged(id: string, c: crm.Contact) {
	const now = (await crm.contacts.doc(id).get()).data() as crm.Contact | undefined;
	if (!now || (now.nextStep ?? '') !== (c.nextStep ?? '')) return;
	const closed = await crm.closeAutomationTasks(id, ['next-step-task']);
	await run(
		'next-step-task',
		async () => {
			const step = nextStepOf(now.nextStep);
			if (!step || !assigneeOf(now)) return closed ? `Closed ${closed} next-step task(s)` : null;
			await addTask('next-step-task', id, now, step.task, step.days);
			return `Task "${step.task}" for ${toWhom(now)}${closed ? `; closed ${closed} old` : ''}`;
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
				if (!c || c.type !== 'fellow' || !MEETING_STAGES.includes(c.stage) || !assigneeOf(c))
					return null;
				// One open suggestion per contact: a renamed or re-dated meeting is not a new one.
				const open = await crm.tasks
					.where('contactId', '==', m.contactId)
					.where('done', '==', false)
					.get();
				if (open.docs.some((t) => t.data().automationId === 'meeting-next-stage')) return null;
				const stage = stageOf(c.type, c.stage)?.label ?? c.stage;
				const day = m.date!.toISOString().slice(0, 10);
				const title = `Met on ${day} (“${m.title}”): move from ${stage} to the next stage?`;
				await addTask('meeting-next-stage', m.contactId, c, title, 1);
				return `Asked ${toWhom(c)} about ${crm.displayName(c)}`;
			},
			m.contactId
		);
	}
}

/** Daily: flag open contacts with no activity for STALE_DAYS. */
export async function staleContacts() {
	await run('stale-contacts', async () => {
		const cutoff = Timestamp.fromMillis(Date.now() - STALE_DAYS * DAY);
		const snap = await crm.contacts
			.where('open', '==', true)
			.where('needsAttention', '==', false)
			.where('lastActivityAt', '<', cutoff)
			.limit(200)
			.get();
		// Daily, so a quiet day is still recorded: it shows the job ran.
		if (snap.empty) return `No contact without activity for ${STALE_DAYS} days`;
		for (const doc of snap.docs) {
			const c = doc.data() as crm.Contact;
			await doc.ref.update({ needsAttention: true });
			// The flag always (Home lists it); a task only for someone, and never a second one.
			if (!assigneeOf(c)) continue;
			const open = await crm.tasks
				.where('contactId', '==', doc.id)
				.where('done', '==', false)
				.get();
			if (open.docs.some((t) => t.data().automationId === 'stale-contacts')) continue;
			await addTask('stale-contacts', doc.id, c, `No activity for ${STALE_DAYS} days: check in`, 1);
		}
		return `${snap.size} contacts flagged`;
	});
}

export async function knowledgeSync() {
	await run('knowledge-sync', async () => {
		const knowledge = await import('../knowledge/index.js');
		const r = await knowledge.importFolder();
		// Recorded on a quiet night too, so Health can tell a stopped schedule from a quiet one.
		if (!r.added && !r.updated && !r.removed) return `${r.imported} documents, nothing changed`;
		return `${r.imported} documents (${r.added} new, ${r.updated} updated, ${r.removed} removed)`;
	});
}

export async function portalSync() {
	await run('portal-sync', async () => {
		const portal = await import('../portal/index.js');
		const r = await portal.run();
		const skipped = r.skipped.length ? `; skipped: ${r.skipped.join('; ')}` : '';
		return `${r.contacts} contacts (${r.created} new, ${r.moved} moved), ${r.tasks} tasks${skipped}`;
	});
}

export const actions = {
	'config.get': async () => ({ automations: AUTOMATIONS, n8n: N8N_AUTOMATIONS }),

	toggle: async (p: any) => {
		const id = str(p.id, 'id');
		if (!automation(id)) throw new HttpsError('not-found', 'Unknown automation.');
		await collection.doc(id).set({ enabled: p.enabled === true }, { merge: true });
		return { ok: true };
	},

	/** A failure someone has dealt with: its error leaves Health until the next run. */
	resolve: async (p: any, auth: any) => {
		const id = str(p.id, 'id');
		if (!automation(id)) throw new HttpsError('not-found', 'Unknown automation.');
		const by = auth?.token?.name || auth?.token?.email || 'someone';
		await collection.doc(id).set({ lastError: null, resolvedBy: by }, { merge: true });
		return { ok: true };
	}
};
