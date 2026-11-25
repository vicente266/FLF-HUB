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

/**
 * What kind of knowledge an entry is, as in the EBS knowledge repo's folders. An imported
 * document's type comes from its top subfolder in Drive (`folders`, lowercased); the team can
 * change it in the Hub.
 *
 * The order is the precedence: when two entries disagree, the one whose type comes first wins
 * (a policy over a decision, a decision over the offer…), then approved over draft, then the more
 * recently approved or reviewed (docs/knowledge.md, "Precedence").
 */
export const TYPES = [
	{
		id: 'policies',
		label: 'Policies',
		help: 'Legal, privacy, wellbeing data, rules. Nothing below may contradict them.',
		folders: ['policies', 'policy', 'legal']
	},
	{
		id: 'decisions',
		label: 'Decisions',
		help: 'What was decided, when and why. Overrides older documents of the types below.',
		folders: ['decisions', 'decision']
	},
	{
		id: 'offer',
		label: 'Offer',
		help: 'The programme, the Pledge, prices and what a Fellow gets.',
		folders: ['offer', 'offers', 'programme', 'program']
	},
	{
		id: 'strategy',
		label: 'Strategy',
		help: 'Goals, positioning, who FLF is for.',
		folders: ['strategy']
	},
	{
		id: 'procedures',
		label: 'Procedures',
		help: 'How one task is done: scoring, surveys, onboarding.',
		folders: ['procedures', 'procedure', 'scoring', 'surveys']
	},
	{
		id: 'workflows',
		label: 'Workflows',
		help: 'Processes across the team and systems (portal, website).',
		folders: ['workflows', 'workflow', 'portal & website']
	},
	{
		id: 'brand',
		label: 'Brand',
		help: 'Voice, messaging, content and media.',
		folders: ['brand', 'flf content base', 'content', 'podcasts & videos']
	},
	{ id: 'glossary', label: 'Glossary', help: 'Terms and what they mean.', folders: ['glossary'] },
	{ id: 'other', label: 'Other', help: 'Not sorted yet: the weakest.', folders: [] }
] as const;
export type KnowledgeType = (typeof TYPES)[number]['id'];

/** The type of a document in this Drive subfolder ('other' when none matches). */
export const typeOfFolder = (folder: string | undefined): KnowledgeType =>
	TYPES.find((t) => (t.folders as readonly string[]).includes((folder ?? '').trim().toLowerCase()))
		?.id ?? 'other';

/** Who may see an entry. `restricted` = admins only (in the Hub and through Claude). */
export const AUDIENCES = [
	{
		id: 'external',
		label: 'External',
		help: 'May be shared with Fellows, partners and the public.'
	},
	{ id: 'internal', label: 'Internal', help: 'The FLF team only. The default.' },
	{ id: 'restricted', label: 'Restricted', help: 'Admins only.' }
] as const;
export type Audience = (typeof AUDIENCES)[number]['id'];

/**
 * Draft until a person approves it (Claude can't). Only an approved entry can be "Always"; an
 * imported document whose text changes in Drive goes back to draft.
 */
export const STATUSES = [
	{ id: 'draft', label: 'Draft' },
	{ id: 'approved', label: 'Approved' }
] as const;
export type Status = (typeof STATUSES)[number]['id'];

/** "Use when …": one sentence that tells Claude when to read the entry. */
export const MAX_USE_WHEN = 300;

/** Months between reviews of an approved entry. */
export const REVIEW_EVERY = [3, 6, 12] as const;
export const DEFAULT_REVIEW_EVERY = 6;
