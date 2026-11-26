import * as crm from '../crm/index';
import { CONTACT_TYPES, PIPELINES, SOURCES, STALE_DAYS } from '../crm/config';
import { Timestamp } from '../utils';

const DAY = 24 * 60 * 60 * 1000;

/**
 * Pipeline numbers for Reports, all as count aggregations (one billed read per 1,000 counted
 * documents, not one per document).
 */
export async function summary() {
	const funnel: Record<string, { stage: string; label: string; count: number }[]> = {};
	for (const type of CONTACT_TYPES) {
		funnel[type] = await Promise.all(
			PIPELINES[type].stages.map(async (s) => ({
				stage: s.id,
				label: s.label,
				count: (
					await crm.contacts.where('type', '==', type).where('stage', '==', s.id).count().get()
				).data().count
			}))
		);
	}

	const since30 = Timestamp.fromMillis(Date.now() - 30 * DAY);
	const sources = await Promise.all(
		SOURCES.map(async (source) => ({
			source,
			count: (
				await crm.contacts
					.where('source', '==', source)
					.where('createdAt', '>=', since30)
					.count()
					.get()
			).data().count
		}))
	);

	return { funnel, sources };
}

/**
 * Home's headline numbers, for one person: their open tasks, their overdue ones (dated only), the
 * team's new contacts in 30 days, and contacts needing attention (open, no activity for STALE_DAYS,
 * live as the screens show it; the daily job's flag lags up to a day) for the team, for them and with
 * no owner. Six count aggregations (one billed read each per 1,000 counted).
 */
export async function kpis(uid: string) {
	const since30 = Timestamp.fromMillis(Date.now() - 30 * DAY);
	const myOpen = crm.tasks.where('assigneeUid', '==', uid).where('done', '==', false);
	const stale = crm.contacts
		.where('open', '==', true)
		.where('lastActivityAt', '<', Timestamp.fromMillis(Date.now() - STALE_DAYS * DAY));
	const [newLast30, team, mine, noOwner, openTasks, overdue] = await Promise.all([
		crm.contacts.where('createdAt', '>=', since30).count().get(),
		stale.count().get(),
		stale.where('ownerUid', '==', uid).count().get(),
		stale.where('ownerUid', '==', null).count().get(),
		myOpen.count().get(),
		// A range on dueAt leaves out undated tasks (null), which are never overdue.
		myOpen.where('dueAt', '<', Timestamp.now()).count().get()
	]);
	return {
		newLast30: newLast30.data().count,
		attentionTeam: team.data().count,
		attentionMine: mine.data().count,
		attentionNoOwner: noOwner.data().count,
		openTasks: openTasks.data().count,
		overdueTasks: overdue.data().count
	};
}

export const actions = {
	summary: async () => summary(),
	kpis: async (_p: unknown, auth: { uid: string }) => ({ kpis: await kpis(auth.uid) })
};
