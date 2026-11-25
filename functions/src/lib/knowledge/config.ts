/**
 * Knowledge: FLF facts, offers and messaging the team keeps current, for Claude to read before it
 * writes anything about FLF (docs/knowledge.md). Same shape and expiry rule as the EBS Hub's
 * knowledge store (`barschool/aihub`, functions/src/lib/knowledge-store.ts).
 */

export const KNOWLEDGE_COLLECTION = 'knowledge';

/** Longest description kept (characters): a long structured section fits, a whole deck doesn't. */
export const MAX_DESCRIPTION = 8000;

export const MAX_LABEL = 80;

/** Entries at most: it is a settings-sized list, read whole on every use. */
export const MAX_ENTRIES = 200;
