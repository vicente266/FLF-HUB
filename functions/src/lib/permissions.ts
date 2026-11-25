/**
 * Every permission a group can grant, `<feature>.<scope>.<action>`. The Admin > Groups screen
 * reads this list through `core:config.get`, so it is defined only here.
 */
export const PERMISSIONS = [
	'crm.any.read',
	'crm.any.write',
	'crm.any.delete',
	'tasks.self.read',
	'tasks.any.read',
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
	// Connect Claude to the Hub (the MCP connector). No admin bypass: admins need it too.
	'claude.self.connect'
] as const;

export type Permission = (typeof PERMISSIONS)[number];
