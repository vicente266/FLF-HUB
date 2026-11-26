/**
 * Every permission a group can grant, `<feature>.<scope>.<action>`. The Admin > Groups screen
 * reads this list through `core:config.get`, so it is defined only here.
 */
export const PERMISSIONS = [
	'crm.any.read',
	'crm.any.write',
	'crm.any.delete',
	'reports.any.read',
	'automations.any.read',
	'automations.any.write',
	'connections.any.read',
	'connections.any.write',
	'health.any.read',
	// The Knowledge list (FLF facts and messaging Claude reads before writing).
	'knowledge.any.read',
	'knowledge.any.write',
	// Health data (PERMA wellbeing). Never served to Claude.
	'wellbeing.any.read',
	// Fellows' income and financial reports.
	'wealth.any.read',
	// FLF TV: the clip queue (read) and reviewing clips and editing the skills (write).
	'tv.any.read',
	'tv.any.write',
	// Connect Claude to the Hub (the MCP connector). No admin bypass: admins need it too.
	'claude.self.connect'
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export interface PermissionInfo {
	id: Permission;
	/** The app it belongs to, as the sidebar names it. */
	app: string;
	/** What a group with it can do, e.g. "CRM — edit". */
	label: string;
	/** One line for the Groups screen. */
	help: string;
	/** Read access that opens the app (what "Can see" on Users lists). */
	opens?: boolean;
	/**
	 * Admins need it too: being an admin doesn't grant it (`NO_ADMIN_BYPASS` in utils.ts, and the
	 * Claude connector's own check).
	 */
	adminsNeedIt?: boolean;
}

const INFO: Record<Permission, Omit<PermissionInfo, 'id'>> = {
	'crm.any.read': {
		app: 'CRM',
		label: 'CRM — view',
		help: "See every contact, its pipeline and its timeline, and the whole team's tasks.",
		opens: true
	},
	'crm.any.write': {
		app: 'CRM',
		label: 'CRM — edit',
		help: 'Add contacts, move stages, set next steps and owners, add notes.'
	},
	'crm.any.delete': {
		app: 'CRM',
		label: 'CRM — delete contacts',
		help: 'Delete a contact for good (not the ones imported from the portal).'
	},
	'reports.any.read': {
		app: 'Reports',
		label: 'Reports — view',
		help: 'Funnel, sources and KPIs.',
		opens: true
	},
	'automations.any.read': {
		app: 'Automations',
		label: 'Automations — view',
		help: 'See what runs on its own, its runs and the n8n workflows.',
		opens: true
	},
	'automations.any.write': {
		app: 'Automations',
		label: 'Automations — switch on and off',
		help: 'Turn automations on or off and mark a failure resolved.'
	},
	'connections.any.read': {
		app: 'Connections',
		label: 'Connections — view',
		help: 'See what the Hub is connected to and test a connection.',
		opens: true
	},
	'connections.any.write': {
		app: 'Connections',
		label: 'Connections — change settings and import',
		help: 'Change connection settings and import the portal sheet now.'
	},
	'health.any.read': {
		app: 'Health',
		label: 'System health — view',
		help: 'See whether every connection and automation is working.',
		opens: true
	},
	'knowledge.any.read': {
		app: 'Knowledge',
		label: 'Knowledge — view',
		help: 'Read what Claude knows about FLF.',
		opens: true
	},
	'knowledge.any.write': {
		app: 'Knowledge',
		label: 'Knowledge — edit and approve',
		help: 'Add, edit, approve and delete entries, and import the Drive folder.'
	},
	'wellbeing.any.read': {
		app: 'Wellbeing',
		label: 'Fellow wellbeing (PERMA) — sensitive',
		help: "Fellows' PERMA check-ins on their contact page. Health data: give it only to who needs it.",
		opens: true,
		adminsNeedIt: true
	},
	'wealth.any.read': {
		app: 'Wealth',
		label: 'Fellow finances — sensitive',
		help: "Fellows' income and financial reports on their contact page.",
		opens: true,
		adminsNeedIt: true
	},
	'tv.any.read': {
		app: 'FLF TV',
		label: 'FLF TV — view',
		help: 'See the videos, their clips and the skills.',
		opens: true
	},
	'tv.any.write': {
		app: 'FLF TV',
		label: 'FLF TV — send videos and edit clips',
		help: 'Send videos, approve and edit clips, and edit the skills.'
	},
	'claude.self.connect': {
		app: 'Claude',
		label: 'Claude — connect',
		help: 'Use the Hub from Claude, with their own permissions.',
		opens: true,
		adminsNeedIt: true
	}
};

/** Each permission with its app, label and one-line help, in PERMISSIONS order. */
export const PERMISSION_CATALOG: PermissionInfo[] = PERMISSIONS.map((id) => ({ id, ...INFO[id] }));
