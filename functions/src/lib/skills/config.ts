/**
 * Skills (docs/skills.md): every Markdown instruction file for Claude and agents FLF keeps, from
 * four sources, in one list with an automatic audit of each. Defined only here; the Skills page
 * reads it through `core:skills.config.get`.
 */

export const SKILL_COLLECTION = 'skill';

/** Where a skill comes from. Its doc id is `<source>-<stable id>`. */
export const SOURCES = [
	{
		id: 'tv',
		label: 'FLF TV',
		help: 'The Clipping and Brand skills the FLF TV worker reads. Edited in FLF TV → Skill.'
	},
	{ id: 'hub', label: 'Hub', help: 'Written here, on the Skills page.' },
	{
		id: 'github',
		label: 'GitHub',
		help: 'SKILL.md files, .claude/skills, .claude/commands and skills/ folders of the listed repos.'
	},
	{ id: 'drive', label: 'Drive', help: 'Markdown, text and Google Docs in the Skills folder.' }
] as const;
export type Source = (typeof SOURCES)[number]['id'];

export const LEVELS = [
	{ id: 'error', label: 'Error', help: 'The skill will not work as intended until it is fixed.' },
	{ id: 'warning', label: 'Warning', help: 'Works, but Claude may not pick it or follow it well.' }
] as const;
export type Level = (typeof LEVELS)[number]['id'];

/** The skill list is settings-sized: read whole, at most this many. */
export const MAX_SKILLS = 500;

/** Files read per GitHub repo and from the Drive folder, at most. */
export const MAX_FILES = 200;

/** A skill's body is kept up to this length (characters). */
export const MAX_BODY = 50_000;

export const MAX_NAME = 100;

/** Claude refuses a SKILL.md whose description is longer. */
export const MAX_DESCRIPTION = 1024;
/** Shorter than this can't say what the skill does and when to use it. */
export const MIN_DESCRIPTION = 20;

/** A body longer than this many lines is hard for Claude to follow: split it. */
export const MAX_LINES = 500;

/** Not changed for this many days: probably out of date. */
export const STALE_DAYS = 180;

/** Which GitHub paths are skills (shown on the page; matched by `isSkillPath` in audit.ts). */
export const GITHUB_PATTERNS = [
	'**/SKILL.md',
	'.claude/skills/**/*.md',
	'.claude/commands/*.md',
	'skills/**/*.md'
] as const;

/**
 * The only host the GitHub token is ever sent to. Fixed in code, not a setting, and every request
 * refuses redirects, so the token can't reach another host.
 */
export const GITHUB_API = 'https://api.github.com';

/** Connection ids (connections/config.ts). */
export const GITHUB_CONNECTION = 'skills-github';
export const DRIVE_CONNECTION = 'skills-drive';

/** Where FLF TV's skills are edited. */
export const TV_SKILL_URL = '/tv?tab=skill';
