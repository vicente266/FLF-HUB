/**
 * One Knowledge entry: an FLF fact, offer or piece of messaging for Claude, written in the Hub or
 * imported from the Knowledge Drive folder. Same base shape as the EBS Hub's knowledge entries.
 */
export type KnowledgeUse = 'always' | 'relevant' | 'off';

export interface KnowledgeEntry {
	id: string;
	label?: string;
	description: string;
	/** Optional expiry as `YYYY-MM-DD`; once past, the entry is no longer given to Claude. */
	expiredAt?: string;
	/** How Claude uses it; missing = always (entries from before uses existed). */
	use?: KnowledgeUse;
	topics?: string[];
	/** `drive` = imported from the Knowledge folder (its text is edited in Drive). */
	source?: 'hub' | 'drive';
	url?: string;
	/** Imported text cut at the import limit. */
	truncated?: boolean;
	updatedBy?: string;
	updatedAt?: unknown;
}

export interface KnowledgeUseOption {
	id: KnowledgeUse;
	label: string;
	help: string;
}
