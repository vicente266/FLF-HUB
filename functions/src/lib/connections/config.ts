/**
 * Every system the Hub connects to. The Connections and Health screens read this through
 * `connections:config.get`; per-connection state (settings, last check, last error) lives in
 * the `connection/{id}` documents. Secrets are never here or in Firestore: they are Secret
 * Manager entries, named in `secrets`, set with `firebase functions:secrets:set <NAME>`.
 */

export type Category = 'platform' | 'messaging' | 'ai';

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
	platform: 'FLF platform',
	messaging: 'Messaging',
	ai: 'AI'
};

export const CONNECTORS: Connector[] = [
	{
		id: 'portal-sheet',
		name: 'FLF Portal sheet',
		category: 'platform',
		availability: 'live',
		description:
			'The portal’s backend Google Sheet (Profiles, Applications, CRM, Tasks, Perma, Wealth). The Hub only reads it, every night and when you press Sync now; the portal and n8n keep writing to it. Test connection checks that no columns are missing.',
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
			'Developer only: share the sheet with the Cloud Functions service account as **Viewer** (never Editor: the Hub must not be able to write to production).',
			'Press Test connection: every tab and column the import needs must be found.',
			'Press Preview import to see what would be imported, then Sync now. It runs again every night.'
		],
		testable: true
	},
	{
		id: 'checkly',
		name: 'Checkly',
		category: 'platform',
		availability: 'live',
		description:
			'External monitoring (free Hobby plan): Checkly checks the website, the portal and the Hub every few minutes from outside. The Hub shows its pass/fail in Health.',
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
			'Create a free Checkly account and add URL monitors (GET only) for the website, the portal login page and the Hub.',
			'Checkly → User settings → API keys: create a key. Developer only: `firebase functions:secrets:set CHECKLY_API_KEY`, deploy.',
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
		id: 'knowledge-folder',
		name: 'Knowledge folder (Drive)',
		category: 'ai',
		availability: 'live',
		description:
			'A Google Drive folder whose Google Docs and text files become Knowledge entries for Claude. The Hub only reads it, every night and when you press Sync now.',
		feeds: ['Knowledge'],
		secrets: [],
		settings: [
			{
				key: 'folderId',
				label: 'Folder id',
				help: 'The part after /folders/ in the folder link. Leave empty for the default FLF Knowledge folder.',
				kind: 'text'
			}
		],
		setup: [
			'Share the folder with the Cloud Functions service account (900685987021-compute@developer.gserviceaccount.com) as **Viewer**.',
			'Press Test connection: it lists the documents it can import.',
			'Knowledge → Sync now imports them; it runs again every night.'
		],
		testable: true
	},
	{
		id: 'claude-connector',
		name: 'Claude connector',
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
	}
];

export function connector(id: string): Connector | undefined {
	return CONNECTORS.find((c) => c.id === id);
}
