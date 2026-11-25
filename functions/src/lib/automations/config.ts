/**
 * The automations the Hub runs. Each one is code (in `automations/index.ts`); its on/off switch
 * and run stats live in `automation/{id}`. The UI reads this list through `automations:config.get`.
 */

export type Trigger = 'contact.stage' | 'contact.nextStep' | 'meeting' | 'schedule';

export interface AutomationDef {
	id: string;
	name: string;
	description: string;
	trigger: Trigger;
	/** Plain-language schedule for `schedule` triggers. */
	schedule?: string;
	/** Connections it uses when they are set up. */
	uses: string[];
	/** On until an admin turns it off. */
	defaultEnabled: boolean;
}

export const AUTOMATIONS: AutomationDef[] = [
	{
		id: 'stage-follow-up',
		name: 'Follow-up task per stage',
		description:
			'When a contact enters a stage, its owner gets the follow-up task defined for that stage, due after the stage’s number of days.',
		trigger: 'contact.stage',
		uses: [],
		defaultEnabled: true
	},
	{
		id: 'next-step-task',
		name: 'Task per next step',
		description:
			'When someone sets a contact’s next step in the Hub, its owner gets a task: “Plan Interaction” → plan the next interaction (2 days), “Awaiting for Response” → follow up (7 days).',
		trigger: 'contact.nextStep',
		uses: [],
		defaultEnabled: true
	},
	{
		id: 'meeting-next-stage',
		name: 'Suggest a stage move after a meeting',
		description:
			'When the portal sheet sync brings in a meeting from the last 14 days with a Fellow in Targets, Aware or Teaser, its owner gets a task: “Met on … — move to the next stage?”. Nobody is moved automatically.',
		trigger: 'meeting',
		uses: ['portal-sheet'],
		defaultEnabled: true
	},
	{
		id: 'stale-contacts',
		name: 'Flag stale contacts',
		description:
			'Every morning, open contacts with no activity for 14 days are marked "needs attention" and their owner gets a task.',
		trigger: 'schedule',
		schedule: 'Every day at 08:00 (Madrid)',
		uses: ['slack'],
		defaultEnabled: true
	},
	{
		id: 'daily-digest',
		name: 'Daily digest',
		description:
			'Every morning, posts yesterday’s new contacts, today’s due tasks and the stale count to Slack.',
		trigger: 'schedule',
		schedule: 'Every day at 08:00 (Madrid)',
		uses: ['slack'],
		defaultEnabled: false
	},
	{
		id: 'portal-sync',
		name: 'Import the portal sheet',
		description:
			'Every night, reads the FLF Portal sheet (CRM, Applications, Profiles, Tasks, Events, Perma, Wealth) into the Hub. Read only on the sheet: the portal and n8n are untouched.',
		trigger: 'schedule',
		schedule: 'Every day at 03:00 (Madrid)',
		uses: ['portal-sheet'],
		defaultEnabled: false
	}
];

/**
 * FLF's automations that run in n8n (production). The Hub only shows them with their live status
 * (`automations:n8n.workflows`) and a link: it never runs, edits or turns them on or off.
 */
export interface N8nAutomation {
	workflowId: string;
	name: string;
	description: string;
	/** Plain-language trigger. */
	when: string;
}

export const N8N_AUTOMATIONS: N8nAutomation[] = [
	{
		workflowId: 'H8nD4J21jpY18yLj',
		name: 'Portal backend',
		when: 'Every request from the portal (webhook ffl-portal)',
		description:
			'Sign-in, password resets, applications, PERMA check-ins, wealth reports and drafts, and the Fellows list for Sherpas. Reads and writes the FLF Portal sheet; emails through Gmail.'
	},
	{
		workflowId: 'H8nD4J21jpY18yLj',
		name: 'PERMA reminders',
		when: 'The 1st, 3rd and 5th of each month at 09:00 (Madrid)',
		description:
			'Fellows on the portal with an earlier check-in and none this month get reminder 1, 2 or 3 by email, with a link to fill in PERMA.'
	},
	{
		workflowId: 'hQaJTYDgW9OxVvIl',
		name: 'Calendar → Events',
		when: 'Every minute, when a meeting starts',
		description:
			'A meeting with a CRM contact in Vicente’s or Aleks’s calendar is added to the sheet’s Events tab, and “Last meeting” and Timeline are updated in CRM and Profiles. The Hub imports those Events.'
	},
	{
		workflowId: 'rvKInrBYhdOGn3DL',
		name: 'Calendar failure alert',
		when: 'When Calendar → Events fails',
		description: 'Emails Vicente and logs the failure in the sync log.'
	},
	{
		workflowId: 'NHeUuA1mgvgtEgPp',
		name: 'Portal failure alert',
		when: 'When the portal backend fails',
		description: 'Emails Vicente.'
	}
];

export function automation(id: string) {
	return AUTOMATIONS.find((a) => a.id === id);
}
