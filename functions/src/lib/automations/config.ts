/**
 * The automations the Hub runs. Each one is code (in `automations/index.ts`); its on/off switch
 * and run stats live in `automation/{id}`. The UI reads this list through `automations:config.get`.
 */

export type Trigger = 'contact.created' | 'contact.stage' | 'schedule';

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
		id: 'assign-owner',
		name: 'Assign a Sherpa',
		description:
			'A new contact without an owner goes to the Sherpa with the fewest open contacts. Mark Sherpas in Admin → Users.',
		trigger: 'contact.created',
		uses: [],
		defaultEnabled: true
	},
	{
		id: 'new-lead-alert',
		name: 'New application alert',
		description: 'Posts every new application from the website to Slack.',
		trigger: 'contact.created',
		uses: ['slack', 'website-forms'],
		defaultEnabled: true
	},
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
		id: 'stale-contacts',
		name: 'Flag stale contacts',
		description:
			'Every morning, open contacts with no activity for the stale period are marked "needs attention" and their owner gets a task.',
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
		id: 'sheets-sync',
		name: 'Sync Google Sheets',
		description: 'Every night, copies the configured sheets for Reports.',
		trigger: 'schedule',
		schedule: 'Every day at 03:00 (Madrid)',
		uses: ['google-sheets'],
		defaultEnabled: true
	}
];

export function automation(id: string) {
	return AUTOMATIONS.find((a) => a.id === id);
}
