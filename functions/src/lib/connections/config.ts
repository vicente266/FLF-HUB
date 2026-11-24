/**
 * Every system the Hub connects to. The Connections and Health screens read this through
 * `connections:config.get`; per-connection state (settings, last check, last error) lives in
 * the `connection/{id}` documents. Secrets are never here or in Firestore: they are Secret
 * Manager entries, named in `secrets`, set with `firebase functions:secrets:set <NAME>`.
 */

export type Category = 'inbound' | 'data' | 'messaging' | 'platform' | 'ai';

/** `live`: implemented here. `planned`: on the roadmap, shown with what it will need. */
export type Availability = 'live' | 'planned';

export interface SettingField {
	key: string;
	label: string;
	help: string;
	/** `list` = one entry per line. */
	kind: 'text' | 'list';
}

export interface Connector {
	id: string;
	name: string;
	category: Category;
	availability: Availability;
	description: string;
	/** Which parts of the Hub use the data. */
	feeds: string[];
	/** Secret Manager names it needs. */
	secrets: string[];
	/** Non-secret settings an admin edits in the Hub. */
	settings: SettingField[];
	/** Steps to set it up, in order. */
	setup: string[];
	/** Whether `connections:test` can check it. */
	testable: boolean;
}

export const CATEGORIES: Record<Category, string> = {
	inbound: 'Inbound',
	data: 'Data sources',
	messaging: 'Messaging',
	platform: 'FLF platform',
	ai: 'AI'
};

export const CONNECTORS: Connector[] = [
	{
		id: 'website-forms',
		name: 'Website forms',
		category: 'inbound',
		availability: 'live',
		description:
			'Applications from foundersforlifefellowship.com (Prospective Fellows, Gurus, Investors) arrive as CRM contacts in their first stage.',
		feeds: ['CRM', 'Automations'],
		secrets: ['LEAD_WEBHOOK_TOKEN'],
		settings: [],
		setup: [
			'Developer only: set the token with `firebase functions:secrets:set LEAD_WEBHOOK_TOKEN` and deploy.',
			'Make each website form POST JSON to the `crmLeadWebhook` URL with the header `x-flf-token: <token>`.',
			'Body: `type` (fellow | guru | investor), `name`, `email`, optional `company`, `linkedin`, `phone`, `message`.',
			'Send one test application and check it appears in CRM and here as "Last event".'
		],
		testable: true
	},
	{
		id: 'portal-sheet',
		name: 'FLF Portal sheet',
		category: 'platform',
		availability: 'live',
		description:
			'The portal’s backend Google Sheet (Profiles, Applications, CRM, Tasks, Perma, Wealth). The Hub only READS it, nightly and on demand: the portal and n8n keep writing to it. The check flags missing columns (schema drift).',
		feeds: ['CRM', 'Tasks', 'Reports', 'Wellbeing'],
		secrets: [],
		settings: [
			{
				key: 'spreadsheetId',
				label: 'Spreadsheet id',
				help: 'Leave empty for the FLF Portal Backend sheet.',
				kind: 'text'
			}
		],
		setup: [
			'Share the sheet with the Cloud Functions service account as **Viewer** (never Editor: the Hub must not be able to write to production).',
			'Press Test: every tab and column the import needs must be found.',
			'Press Dry run to see what would be imported, then Sync now. It runs again every night.'
		],
		testable: true
	},
	{
		id: 'google-sheets',
		name: 'Google Sheets',
		category: 'data',
		availability: 'live',
		description:
			'Reads ranges from FLF spreadsheets (cohort tracking, Fellow metrics, finances) every night and shows them in Reports.',
		feeds: ['Reports'],
		secrets: [],
		settings: [
			{
				key: 'sources',
				label: 'Sheets',
				help: 'One per line: `Name | spreadsheet id | range`, e.g. `Cohort | 1AbC… | Alpha!A1:H200`.',
				kind: 'list'
			}
		],
		setup: [
			'Share each spreadsheet (Viewer) with the Cloud Functions service account `<project-id>@appspot.gserviceaccount.com`.',
			'Add one line per sheet under Settings, then press Test.',
			'Data refreshes nightly; "Sync now" refreshes it immediately.'
		],
		testable: true
	},
	{
		id: 'bigquery',
		name: 'BigQuery',
		category: 'data',
		availability: 'live',
		description:
			'Warehouse for reporting: CRM history exported nightly, plus any dataset FLF already has. Reports query its views.',
		feeds: ['Reports'],
		secrets: [],
		settings: [
			{
				key: 'projectId',
				label: 'Project id',
				help: 'GCP project that holds the dataset.',
				kind: 'text'
			},
			{
				key: 'dataset',
				label: 'Dataset',
				help: 'Dataset the Hub writes to and reads from, e.g. `flf`.',
				kind: 'text'
			}
		],
		setup: [
			'Create the dataset in BigQuery (location EU).',
			'Grant the Cloud Functions service account "BigQuery Data Editor" on the dataset and "BigQuery Job User" on the project.',
			'Fill in project id and dataset, then press Test.'
		],
		testable: true
	},
	{
		id: 'slack',
		name: 'Slack',
		category: 'messaging',
		availability: 'live',
		description:
			'Posts to the team channel: new applications, contacts that need attention and the daily digest.',
		feeds: ['Automations'],
		secrets: ['SLACK_WEBHOOK_URL'],
		settings: [],
		setup: [
			'In Slack, create an app with an Incoming Webhook for the team channel.',
			'Developer only: `firebase functions:secrets:set SLACK_WEBHOOK_URL` with the webhook URL, then deploy.',
			'Press Test: a message should appear in the channel.'
		],
		testable: true
	},
	{
		id: 'uptime',
		name: 'Uptime (built in)',
		category: 'platform',
		availability: 'live',
		description:
			'Every hour the Hub opens each address (GET only) and records the status and response time: the website, the portal, the Hub. Never calls the n8n webhook, which would run production actions.',
		feeds: ['Health'],
		secrets: [],
		settings: [
			{
				key: 'urls',
				label: 'Addresses',
				help: 'One per line. GET only; no webhooks that change data.',
				kind: 'list'
			}
		],
		setup: ['List the public addresses to watch, then press Test.'],
		testable: true
	},
	{
		id: 'checkly',
		name: 'Checkly',
		category: 'platform',
		availability: 'live',
		description:
			'External monitoring (free Hobby plan): Checkly checks the website, the portal and the Hub every few minutes from outside, even a portal sign-in. The Hub shows its pass/fail in Health.',
		feeds: ['Health'],
		secrets: ['CHECKLY_API_KEY'],
		settings: [
			{
				key: 'accountId',
				label: 'Account id',
				help: 'Checkly → Account settings → General.',
				kind: 'text'
			}
		],
		setup: [
			'Create a free Checkly account and add API or browser checks for the website, the portal login page and the Hub.',
			'Checkly → User settings → API keys: create a read key. Developer only: `firebase functions:secrets:set CHECKLY_API_KEY`, deploy.',
			'Put the account id here and press Test.'
		],
		testable: true
	},
	{
		id: 'n8n',
		name: 'n8n workflows',
		category: 'platform',
		availability: 'live',
		description:
			'Reads the executions of FLF’s n8n workflows (FFL Google Sheets, Calendar → Events, the alerts) and reports failures in Health. Read only: it never runs, edits or publishes a workflow.',
		feeds: ['Health'],
		secrets: ['N8N_API_KEY'],
		settings: [
			{
				key: 'baseUrl',
				label: 'n8n address',
				help: 'e.g. https://vv1.app.n8n.cloud',
				kind: 'text'
			},
			{
				key: 'workflows',
				label: 'Workflows',
				help: 'One per line: `Name | workflow id`, e.g. `FFL Google Sheets | H8nD4J21jpY18yLj`.',
				kind: 'list'
			}
		],
		setup: [
			'n8n → Settings → n8n API: create an API key (n8n has no read-only key: keep it in Secret Manager only). Developer only: `firebase functions:secrets:set N8N_API_KEY`, deploy.',
			'Fill in the address and the workflows, then press Test.'
		],
		testable: true
	},
	{
		id: 'fellow-portal',
		name: 'Fellow Portal',
		category: 'platform',
		availability: 'planned',
		description:
			'portal.foundersforlifefellowship.com. Accepted Fellows get portal access from the CRM; portal activity (sessions, retreats, check-ins) flows back to their timeline.',
		feeds: ['CRM', 'Reports', 'Health'],
		secrets: ['PORTAL_API_KEY'],
		settings: [
			{ key: 'baseUrl', label: 'Portal API URL', help: 'Base URL of the portal API.', kind: 'text' }
		],
		setup: [
			'Reading the portal’s data is live through the FLF Portal sheet connection.',
			'Writing back (giving an accepted Fellow portal access) waits until the portal moves off the sheet: n8n is production.'
		],
		testable: false
	},
	{
		id: 'gmail',
		name: 'Gmail',
		category: 'messaging',
		availability: 'planned',
		description:
			'Sends automation emails (application received, interview invite) from the FLF mailbox and logs email threads on the contact timeline.',
		feeds: ['CRM', 'Automations'],
		secrets: ['GMAIL_CREDENTIALS'],
		settings: [
			{ key: 'sender', label: 'Send as', help: 'Mailbox emails are sent from.', kind: 'text' }
		],
		setup: [
			'Google Workspace admin: service account with domain-wide delegation, scope gmail.send.',
			'Store its JSON key as `GMAIL_CREDENTIALS`.'
		],
		testable: false
	},
	{
		id: 'google-calendar',
		name: 'Google Calendar',
		category: 'messaging',
		availability: 'planned',
		description: 'Interviews and retreats on the contact timeline; interview stage books a slot.',
		feeds: ['CRM', 'Tasks'],
		secrets: ['GMAIL_CREDENTIALS'],
		settings: [
			{
				key: 'calendarId',
				label: 'Calendar',
				help: 'Shared calendar for interviews.',
				kind: 'text'
			}
		],
		setup: ['Reuses the Gmail service account with the calendar scope added.'],
		testable: false
	},
	{
		id: 'claude-connector',
		name: 'Claude connector (MCP)',
		category: 'ai',
		availability: 'live',
		description:
			'Lets each person use the Hub from Claude (claude.ai, Claude Code): read and manage contacts, tasks, reports, automations and connections, with their own permissions. Changes show as "via Claude".',
		feeds: ['CRM', 'Tasks', 'Reports', 'Automations', 'Connections', 'Health'],
		secrets: ['FLF_MCP_KEY'],
		settings: [],
		setup: [
			'Developer only: `openssl rand -base64 48 | firebase functions:secrets:set FLF_MCP_KEY --data-file=-`, then deploy.',
			'Developer only: put the `claudeMcp` URL + `/mcp` in `functions/.env` as FLF_CONNECTOR_URL and deploy again.',
			'Admin: give the people who may use Claude a group with "Claude — connect" (admins too).',
			'claude.ai: an Owner adds it under Organization settings → Connectors → Add custom connector with that address; each person then clicks Connect.',
			'Claude Code: `claude mcp add --transport http --scope user flf-hub <address>`, then `/mcp` to sign in.'
		],
		testable: true
	},
	{
		id: 'claude-api',
		name: 'Claude AI features (Anthropic API)',
		category: 'ai',
		availability: 'planned',
		description:
			'AI inside the Hub itself: summarise applications, draft follow-ups, score fit, like the AI tools in the EBS Hub.',
		feeds: ['CRM', 'Reports'],
		secrets: ['ANTHROPIC_API_KEY'],
		settings: [],
		setup: ['Store an Anthropic API key as `ANTHROPIC_API_KEY`.'],
		testable: false
	}
];

export function connector(id: string): Connector | undefined {
	return CONNECTORS.find((c) => c.id === id);
}
