/**
 * The CRM's shape: which kinds of contact exist and the pipeline each one moves through. The
 * UI fetches this through `crm:config.get`, so it is defined only here.
 */

export const CONTACT_TYPES = ['fellow', 'guru', 'investor', 'partner'] as const;
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
	/** A losing final stage: moving a contact here asks why (kept on the contact and its timeline). */
	askReason?: boolean;
}

export interface Pipeline {
	label: string;
	plural: string;
	description: string;
	stages: Stage[];
}

/**
 * A contact's next step, the "Status" column of the portal's CRM sheet. Setting one in the Hub
 * gives the owner a task (automation `next-step-task`), due after `days`.
 */
export interface NextStep {
	id: string;
	/** As written in the sheet's Status column. */
	label: string;
	task: string;
	days: number;
}

export const NEXT_STEPS: NextStep[] = [
	{ id: 'plan-interaction', label: 'Plan Interaction', task: 'Plan the next interaction', days: 2 },
	{
		id: 'awaiting-response',
		label: 'Awaiting for Response',
		task: 'Still no answer? Follow up',
		days: 7
	}
];

export const nextStepOf = (id: string | null | undefined) => NEXT_STEPS.find((s) => s.id === id);

/** The sheet's Status text → next-step id ('' when blank or unknown). */
export const nextStepFromSheet = (text: string) =>
	NEXT_STEPS.find((s) => s.label.toLowerCase() === text.trim().toLowerCase())?.id ?? '';

/** Stages a meeting can move forward: after one, the owner is asked whether to move the contact. */
export const MEETING_STAGES = ['target', 'aware', 'teaser'];

export const PIPELINES: Record<ContactType, Pipeline> = {
	fellow: {
		label: 'Fellow',
		plural: 'Fellows',
		description:
			'Founders, from application or target to Fellow. The stages of the portal’s CRM sheet (Targets, FOF – They are Aware, FOF – Teaser Received, Fellows, Lost).',
		stages: [
			{
				id: 'application',
				label: 'Applications',
				followUpDays: 3,
				followUp: 'Review the application'
			},
			{ id: 'target', label: 'Targets', followUpDays: 7, followUp: 'Plan the first interaction' },
			{
				id: 'aware',
				label: 'FOF – They are Aware',
				followUpDays: 7,
				followUp: 'Send the teaser'
			},
			{
				id: 'teaser',
				label: 'FOF – Teaser Received',
				followUpDays: 7,
				followUp: 'Follow up on the teaser'
			},
			{ id: 'fellow', label: 'Fellows', final: true },
			{ id: 'lost', label: 'Lost', final: true, askReason: true }
		]
	},
	guru: {
		label: 'Guru',
		plural: 'Gurus',
		description: 'Experts who teach and guide Fellows.',
		stages: [
			{ id: 'prospect', label: 'Prospect', followUpDays: 3, followUp: 'Reach out' },
			{
				id: 'conversation',
				label: 'Conversation',
				followUpDays: 7,
				followUp: 'Plan the next conversation'
			},
			{ id: 'onboarding', label: 'Onboarding', followUpDays: 7, followUp: 'Finish onboarding' },
			{ id: 'active', label: 'Active', final: true },
			{ id: 'declined', label: 'Declined', final: true, askReason: true }
		]
	},
	investor: {
		label: 'Investor',
		plural: 'Investors',
		description: 'Investors we connect with Fellows’ companies.',
		stages: [
			{ id: 'prospect', label: 'Prospect', followUpDays: 3, followUp: 'Reach out' },
			{ id: 'intro', label: 'Intro', followUpDays: 7, followUp: 'Follow up after the intro' },
			{ id: 'engaged', label: 'Engaged', followUpDays: 14, followUp: 'Check in' },
			{ id: 'roster', label: 'On roster', final: true },
			{ id: 'declined', label: 'Declined', final: true, askReason: true }
		]
	},
	partner: {
		label: 'Partner',
		plural: 'Partners',
		description:
			'Go-to-market: organisations FLF sells to or partners with (VC funds, universities, accelerators, corporates). Company = the organisation, name = the main contact. Discussion notes go on the timeline.',
		stages: [
			{ id: 'target', label: 'Targets', followUpDays: 5, followUp: 'Make the first contact' },
			{
				id: 'contacted',
				label: 'Contacted',
				followUpDays: 7,
				followUp: 'Follow up on the first message'
			},
			{
				id: 'conversation',
				label: 'In conversation',
				followUpDays: 7,
				followUp: 'Plan the next conversation'
			},
			{ id: 'proposal', label: 'Proposal', followUpDays: 5, followUp: 'Follow up on the proposal' },
			{ id: 'won', label: 'Partners', final: true },
			{ id: 'lost', label: 'Lost', final: true, askReason: true }
		]
	}
};

/** Kinds of organisation a Partner is (go-to-market segments). */
export const SEGMENTS = [
	{ id: 'vc-fund', label: 'VC fund' },
	{ id: 'university', label: 'University' },
	{ id: 'accelerator', label: 'Accelerator / incubator' },
	{ id: 'corporate', label: 'Corporate' },
	{ id: 'foundation', label: 'Foundation / NGO' },
	{ id: 'other', label: 'Other' }
] as const;

/** A go-to-market strategy's state. */
export const STRATEGY_STATUSES = ['active', 'paused', 'done'] as const;

/** Strategies in the `strategy` collection; each groups the Partners it targets. */
export const STRATEGY_COLLECTION = 'strategy';

/** Days without activity after which an open contact needs attention. */
export const STALE_DAYS = 14;

export function stageOf(type: ContactType, id: string): Stage | undefined {
	return PIPELINES[type].stages.find((s) => s.id === id);
}

export function firstStage(type: ContactType): string {
	return PIPELINES[type].stages[0].id;
}
