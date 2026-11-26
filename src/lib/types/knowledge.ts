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
	/** How Claude uses it; missing = relevant. Only an approved entry is really "Always". */
	use?: KnowledgeUse;
	topics?: string[];
	/** `drive` = imported from the Knowledge folder (its text is edited in Drive). */
	source?: 'hub' | 'drive';
	url?: string;
	/** Imported text cut at the import limit. */
	truncated?: boolean;
	updatedBy?: string;
	updatedAt?: unknown;
	/** The card (docs/knowledge.md, "The card"). Missing type = other. */
	type?: string;
	/** "Use when …". */
	useWhen?: string;
	/** Missing = internal. */
	audience?: 'external' | 'internal' | 'restricted';
	/** Missing = draft. */
	status?: 'draft' | 'approved';
	approvedBy?: string;
	approvedOn?: string;
	lastReviewed?: string;
	reviewEvery?: number;
	/** Its outline (headings, no text), stored on save and import. */
	sections?: KnowledgeSection[];
	/** Its length in words, stored with the outline. */
	words?: number;
}

/** One heading of an entry's outline (docs/knowledge.md, "Sections"). */
export interface KnowledgeSection {
	id: string;
	title: string;
	level: number;
	chars: number;
	words: number;
}

/** One "When relevant" entry in Claude's index, as knowledge.list returns it. */
export interface KnowledgeIndexRow {
	id: string;
	title: string;
	type: string;
	rank: number;
	status: 'draft' | 'approved';
	use_when?: string;
	topics?: string[];
	words: number;
	outline?: string[];
	outline_more?: number;
	reviewed?: string;
	review_due?: boolean;
	audience?: string;
}

/** Claude's index: the "When relevant" entries grouped by type, in precedence order. */
export interface KnowledgeIndexGroup {
	type: string;
	label: string;
	entries: KnowledgeIndexRow[];
}

/** Knowledge found missing, contradictory or out of date, reported by Claude or a person. */
export interface KnowledgeGap {
	id: string;
	kind: 'missing' | 'conflict' | 'outdated';
	note: string;
	entryIds: string[];
	query: string;
	reportedBy: string;
	via: 'claude' | 'hub';
	status: 'open' | 'resolved';
	/** Times reported while open (a repeat within 7 days only bumps it). */
	count?: number;
	lastReportedAt?: unknown;
	resolvedBy?: string;
	/** The note left on resolving. */
	resolution?: string;
	createdAt?: unknown;
	resolvedAt?: unknown;
}

/** A choice defined in the backend config (type, audience), with its help text. */
export interface KnowledgeOption {
	id: string;
	label: string;
	help: string;
}

export interface KnowledgeUseOption {
	id: KnowledgeUse;
	label: string;
	help: string;
}
