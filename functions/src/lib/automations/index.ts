import { HttpsError } from 'firebase-functions/v2/https';
import { db } from '../../firestore';
import { serverTimestamp, increment, str, createLogger, Timestamp } from '../utils';
import * as crm from '../crm/index';
import { stageOf, STALE_DAYS, type ContactType } from '../crm/config';
import * as user from '../user';
import * as connections from '../connections/index';
import { AUTOMATIONS, automation } from './config';

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

/** The Sherpa with the fewest open contacts (one count query per Sherpa). */
async function leastLoadedSherpa() {
	const sherpas = await user.sherpas();
	let best: (typeof sherpas)[number] | null = null;
	let bestCount = Infinity;
	for (const s of sherpas) {
		const snap = await crm.contacts
			.where('ownerUid', '==', s.uid)
			.where('open', '==', true)
			.count()
			.get();
		if (snap.data().count < bestCount) {
			best = s;
			bestCount = snap.data().count;
		}
	}
	return best;
}

/** `contact/{id}` created. */
export async function onContactCreated(id: string, c: crm.Contact, slackUrl: string | undefined) {
	await run(
		'assign-owner',
		async () => {
			if (c.ownerUid) return null;
			const s = await leastLoadedSherpa();
			if (!s) throw new Error('No Sherpa to assign: mark at least one in Admin → Users.');
			const name = s.name || s.email;
			await crm.contacts.doc(id).update({ ownerUid: s.uid, ownerName: name });
			await crm.logActivity(id, 'automation', `Assigned to ${name}`, 'Automation');
			// The stage follow-up for the first stage needs the owner, so it runs here.
			const stage = stageOf(c.type, c.stage);
			if (stage?.followUp)
				await addTask(id, c.name, s.uid, stage.followUp, stage.followUpDays ?? 3);
			return `Assigned to ${name}`;
		},
		id
	);

	await run(
		'new-lead-alert',
		async () => {
			if (c.source !== 'website') return null;
			const sent = await connections.slack(
				slackUrl,
				`New ${c.type} application: *${c.name}*${c.company ? ` (${c.company})` : ''} — ${c.email}`
			);
			return sent ? 'Posted to Slack' : null;
		},
		id
	);
}

/** `contact/{id}` moved to another stage. */
export async function onStageChanged(id: string, c: crm.Contact) {
	await run(
		'stage-follow-up',
		async () => {
			const stage = stageOf(c.type as ContactType, c.stage);
			if (!stage?.followUp || !c.ownerUid) return null;
			await addTask(id, c.name, c.ownerUid, stage.followUp, stage.followUpDays ?? 3);
			return `Task "${stage.followUp}" for ${c.ownerName}`;
		},
		id
	);
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
					c.name,
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

export async function sheetsSync() {
	await run('sheets-sync', async () => {
		const n = await connections.syncSheets();
		return n ? `${n} sheets synced` : null;
	});
}

export const actions = {
	'config.get': async () => ({ automations: AUTOMATIONS }),

	toggle: async (p: any) => {
		const id = str(p.id, 'id');
		if (!automation(id)) throw new HttpsError('not-found', 'Unknown automation.');
		await collection.doc(id).set({ enabled: p.enabled === true }, { merge: true });
		return { ok: true };
	}
};
