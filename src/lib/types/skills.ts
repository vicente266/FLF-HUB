/**
 * Skills (docs/skills.md): every Markdown instruction file for Claude and agents, from FLF TV, the
 * Hub, GitHub and the Skills Drive folder, with its audit. Shapes of `core:skills.*` answers.
 */
export type SkillSource = 'tv' | 'hub' | 'github' | 'drive';
export type SkillLevel = 'error' | 'warning';

export interface SkillIssue {
	level: SkillLevel;
	code: string;
	message: string;
}

export interface Skill {
	/** `<source>-<stable id>`. */
	id: string;
	name: string;
	description: string;
	source: SkillSource;
	/** Repo/path, Drive path, "Hub" or the FLF TV tab. */
	location: string;
	/** GitHub or Drive link, or a Hub path (`/tv?tab=skill`); '' for Hub skills. */
	url: string;
	/** Last change at its source (ms); null when unknown. */
	updatedAt: number | null;
	importedAt: number | null;
	audit: SkillIssue[];
	/** Body cut at the import limit. */
	truncated: boolean;
	updatedBy: string;
}

export interface SkillDetail extends Skill {
	/** The whole file as stored. */
	body: string;
	/** The body without its front matter. */
	content: string;
	frontMatter: Record<string, string>;
}

/** A choice defined in the backend config (source, level), with its help text. */
export interface SkillOption {
	id: string;
	label: string;
	help: string;
}

/** What one import of a source did. */
export interface SkillSourceReport {
	configured: boolean;
	files: number;
	added: number;
	updated: number;
	removed: number;
	skipped: string[];
}

export interface SkillsConfig {
	sources: SkillOption[];
	levels: SkillOption[];
	patterns: string[];
	limits: {
		maxBody: number;
		maxName: number;
		maxDescription: number;
		minDescription: number;
		maxLines: number;
		staleDays: number;
		maxSkills: number;
	};
	repos: string[];
	folder: { id: string; url: string } | null;
	lastSync: {
		github: (SkillSourceReport & { at: number | null }) | null;
		drive: (SkillSourceReport & { at: number | null }) | null;
	};
}
