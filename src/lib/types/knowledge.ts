/**
 * One Knowledge entry: an FLF fact, offer or piece of messaging Claude reads before writing.
 * Same shape as the EBS Hub's knowledge entries.
 */
export interface KnowledgeEntry {
	id: string;
	label?: string;
	description: string;
	/** Optional expiry as `YYYY-MM-DD`; once past, the entry is no longer given to Claude. */
	expiredAt?: string;
	updatedBy?: string;
	updatedAt?: unknown;
}
