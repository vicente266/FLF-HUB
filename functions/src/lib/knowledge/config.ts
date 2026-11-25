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

/** How Claude uses an entry. */
export const USES = [
	{ id: 'always', label: 'Always', help: 'Claude reads it before writing anything about FLF.' },
	{
		id: 'relevant',
		label: 'When relevant',
		help: 'Claude sees its title and topics, and opens it when the task needs it.'
	},
	{ id: 'off', label: 'Off', help: 'Kept here, never given to Claude.' }
] as const;
export type Use = (typeof USES)[number]['id'];

/** Topics an entry can carry (free text), at most this many, each this long. */
export const MAX_TOPICS = 8;
export const MAX_TOPIC = 30;

/**
 * The Drive folder whose documents are imported as Knowledge (read only). The Knowledge folder
 * connection can point elsewhere. Share it with the Functions service account as Viewer.
 */
export const DEFAULT_FOLDER_ID = '1Jlkr4iAe4YWL3l4PK-9WzPQxi7Mt9fjh';

/** An imported document's text is kept up to this length (a hand-written entry: MAX_DESCRIPTION). */
export const MAX_IMPORTED = 50_000;

/** Imported entries' ids: `drive-<file id>`, so a re-import updates the same entry. */
export const DRIVE_PREFIX = 'drive-';
