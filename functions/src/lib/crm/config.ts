/**
 * The CRM's shape: which kinds of contact exist and the pipeline each one moves through. The
 * UI fetches this through `crm:config.get`, so it is defined only here.
 */

export const CONTACT_TYPES = ['fellow', 'guru', 'investor'] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];

export const SOURCES = ['website', 'referral', 'event', 'portal', 'manual'] as const;
export type Source = (typeof SOURCES)[number];

export interface Stage {
	id: string;
	label: string;
	/** A final stage ends the pipeline: no follow-ups, never stale. */
	final?: boolean;
	/** Days after entering the stage that the owner gets a follow-up task. */
	followUpDays?: number;
	/** Title of that follow-up task. */
	followUp?: string;
}

export interface Pipeline {
	label: string;
	plural: string;
	description: string;
	stages: Stage[];
}

export const PIPELINES: Record<ContactType, Pipeline> = {
	fellow: {
		label: 'Fellow',
		plural: 'Fellows',
		description: 'Founders who apply to join the Fellowship.',
		stages: [
			{ id: 'lead', label: 'Lead', followUpDays: 2, followUp: 'First reply to the applicant' },
			{ id: 'screening', label: 'Screening', followUpDays: 5, followUp: 'Finish screening' },
			{ id: 'interview', label: 'Interview', followUpDays: 7, followUp: 'Decide after interview' },
			{ id: 'offer', label: 'Offer', followUpDays: 7, followUp: 'Follow up on the pledge' },
			{ id: 'fellow', label: 'Fellow', final: true },
			{ id: 'declined', label: 'Declined', final: true }
		]
	},
	guru: {
		label: 'Guru',
		plural: 'Gurus',
		description: 'Experts who teach and guide Fellows.',
		stages: [
			{ id: 'prospect', label: 'Prospect', followUpDays: 3, followUp: 'Reach out' },
			{ id: 'conversation', label: 'Conversation', followUpDays: 7, followUp: 'Next conversation' },
			{ id: 'onboarding', label: 'Onboarding', followUpDays: 7, followUp: 'Finish onboarding' },
			{ id: 'active', label: 'Active', final: true },
			{ id: 'declined', label: 'Declined', final: true }
		]
	},
	investor: {
		label: 'Investor',
		plural: 'Investors',
		description: 'Investors we connect with Fellows’ companies.',
		stages: [
			{ id: 'prospect', label: 'Prospect', followUpDays: 3, followUp: 'Reach out' },
			{ id: 'intro', label: 'Intro', followUpDays: 7, followUp: 'Follow up after intro' },
			{ id: 'engaged', label: 'Engaged', followUpDays: 14, followUp: 'Check in' },
			{ id: 'roster', label: 'On roster', final: true },
			{ id: 'declined', label: 'Declined', final: true }
		]
	}
};

/** Days without activity after which an open contact needs attention. */
export const STALE_DAYS = 14;

export function stageOf(type: ContactType, id: string): Stage | undefined {
	return PIPELINES[type].stages.find((s) => s.id === id);
}

export function firstStage(type: ContactType): string {
	return PIPELINES[type].stages[0].id;
}
