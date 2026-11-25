import * as crm from '../crm/index';
import { CONTACT_TYPES, PIPELINES, SOURCES } from '../crm/config';
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

	const [newLast30, needsAttention, openTasks, overdue] = await Promise.all([
		crm.contacts.where('createdAt', '>=', since30).count().get(),
		crm.contacts.where('open', '==', true).where('needsAttention', '==', true).count().get(),
		crm.tasks.where('done', '==', false).count().get(),
		crm.tasks.where('done', '==', false).where('dueAt', '<', Timestamp.now()).count().get()
	]);

	return {
		funnel,
		sources,
		kpis: {
			newLast30: newLast30.data().count,
			needsAttention: needsAttention.data().count,
			openTasks: openTasks.data().count,
			overdueTasks: overdue.data().count
		}
	};
}

export const actions = {
	summary: async () => summary()
};
