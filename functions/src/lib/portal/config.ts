/**
 * The FLF Portal's backend Google Sheet ("FLF Portal Backend") and how the Hub reads it
 * (docs/portal-import.md). The portal and its n8n workflow ("FFL Google Sheets") are production
 * and keep writing to the sheet: the Hub only ever READS it. Nothing here writes to the sheet or
 * calls n8n.
 */

/** The sheet's id, unless the Connections card overrides it. */
export const DEFAULT_SPREADSHEET_ID = '1n0vJ2dzxS4Y4tmrCCe5X8RAe_qa4gLlEYNBVl8tnF5Y';

/**
 * How the Hub names a meeting type of the Events tab, when the sheet's value differs. The sheet and
 * the calendar flow keep their own value; titles stay as people write them.
 */
export const EVENT_TYPE_LABELS: Record<string, string> = { '1-2-1': '1:1 Mentorship' };

/** Participant columns of the Events tab (Participant1 … Participant19). */
export const EVENT_PARTICIPANTS = 19;

/**
 * The tabs the import reads and the columns it needs from each. A header missing from the sheet
 * is schema drift: the Health check reports it and the import refuses that tab rather than
 * guessing. Columns not listed here are never read into the Hub.
 */
export const TABS = {
	crm: {
		name: 'CRM ',
		columns: [
			'Name',
			'Email',
			'Company Name',
			'Last Meeting (N8N)',
			'Status',
			'Stage',
			'Scoring',
			'Notes',
			'Reason Lost'
		]
	},
	applications: {
		name: 'Applications',
		columns: ['Name', 'Email', 'Company', 'Status', 'LinkedIn', 'WhyNow', 'ReferredBy', 'AppliedAt']
	},
	profiles: {
		name: 'Profiles',
		// Never: PasswordHash, Reset Token, Reset Expiry, Permissions, Read Versions.
		columns: [
			'Email',
			'Name',
			'Username',
			'Role',
			'Cohort',
			'Pledge Signed',
			'Pledge Date',
			'Company Name',
			'Company URL',
			'LinkedIn',
			'Location',
			'Sherpa Name',
			'Archetype',
			'Funnel Stage',
			'Last Interaction',
			'Show in portal',
			'Contract URL',
			'Reasons Why',
			'Starting Income',
			'Current Income',
			'Growth'
		]
	},
	tasks: { name: 'Tasks', columns: ['Task', 'Owner', 'Status', 'Notes', 'Due Date', 'Task ID'] },
	perma: {
		name: 'Perma',
		columns: [
			'Submission ID',
			'Founder Email',
			'Completion Date',
			'P',
			'E',
			'R',
			'M',
			'A',
			'N',
			'H',
			'Loneliness',
			'Happiness',
			'Overall'
		]
	},
	/**
	 * Meetings, written by the n8n workflow "Calendar → Events database" when a calendar event with
	 * a CRM contact starts. Participants are CRM names; ALL PARTICIPANTS is a formula and not read.
	 */
	events: {
		name: 'Events',
		columns: [
			'Show in portal',
			'Title',
			'Type',
			'Date',
			'Description',
			...Array.from({ length: EVENT_PARTICIPANTS }, (_, i) => `Participant${i + 1}`)
		]
	},
	wealth: {
		name: 'Wealth',
		columns: [
			'Submission ID',
			'Founder Email',
			'Completion Date',
			'Report Type',
			'Row Type',
			'Gross EUR',
			'Net EUR',
			'Value EUR'
		]
	}
} as const;

export type TabKey = keyof typeof TABS;

/** CRM sheet stage → Hub fellow stage. */
export const STAGE_MAP: Record<string, string> = {
	targets: 'target',
	'fof - they are aware': 'aware',
	'fof - teaser received': 'teaser',
	fellows: 'fellow',
	lost: 'lost'
};

/** Columns whose header names the column that is never imported, for the docs and the check. */
export const NEVER_IMPORTED = [
	'PasswordHash',
	'Reset Token',
	'Reset Expiry',
	'Permissions',
	'Read Versions'
];

/** Rows read per tab at most (the sheets hold about 1,000 rows each). */
export const MAX_ROWS = 2000;
