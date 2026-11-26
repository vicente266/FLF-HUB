import { createHash } from 'node:crypto';
import { HttpsError } from 'firebase-functions/v2/https';
import { GoogleAuth } from 'google-auth-library';
import { db } from '../../firestore';
import { callVia } from '../call-context';
import { createLogger, increment, serverTimestamp, str } from '../utils';
import { fold, sectionText, sectionsOf, wordCount, type Section } from './sections';
import { searchEntries, MAX_RESULTS } from './search';
import {
	DEFAULT_FOLDER_ID,
	DRIVE_PREFIX,
	KNOWLEDGE_COLLECTION,
	MAX_DESCRIPTION,
	MAX_ENTRIES,
	MAX_IMPORTED,
	MAX_LABEL,
	MAX_TOPIC,
	MAX_TOPICS,
	MAX_USE_WHEN,
	USES,
	TYPES,
	AUDIENCES,
	STATUSES,
	REVIEW_EVERY,
	DEFAULT_REVIEW_EVERY,
	ALWAYS_BUDGET_WORDS,
	MAX_SECTIONS,
	INDEX_OUTLINE,
	MAX_READ_SECTIONS,
	GAP_COLLECTION,
	GAP_KINDS,
	MAX_GAP_NOTE,
	MAX_GAP_QUERY,
	MAX_GAP_ENTRIES,
	GAP_REPEAT_DAYS,
	typeOfFolder,
	type Use,
	type KnowledgeType,
	type Audience,
	type Status,
	type GapKind
} from './config';

/**
 * The team's knowledge list (docs/knowledge.md), ported from the EBS Hub's knowledge store. One
 * document per entry, written in the Hub or imported from the Knowledge Drive folder (read only:
 * the Hub never writes to Drive). Each entry has a `use` deciding how Claude gets it: `always`
 * (its text goes with every flf_get_knowledge), `relevant` (Claude sees its title and topics and
 * asks for the text when the task needs it) or `off`. An entry with `expiredAt` (`YYYY-MM-DD`)
 * before today is inactive whatever its use. The list is settings-sized: read whole, filtered in
 * memory, fresh on every use.
 */

const logger = createLogger('knowledge');
export const collection = db.collection(KNOWLEDGE_COLLECTION);

export interface Knowledge {
	label?: string;
	description: string;
	/** Optional expiry as `YYYY-MM-DD`; valid through that day. */
	expiredAt?: string;
	/** How Claude uses it; missing = `relevant` (entries written before uses existed). */
	use?: Use;
	topics?: string[];
	/** `drive` when imported from the Knowledge folder; missing = written in the Hub. */
	source?: 'hub' | 'drive';
	/** Its card, as in the EBS knowledge repo's header (docs/knowledge.md, "The card"). */
	type?: KnowledgeType;
	/** "Use when …": when Claude should read it. */
	useWhen?: string;
	/** Missing = internal. */
	audience?: Audience;
	/** Missing = draft. */
	status?: Status;
	approvedBy?: string;
	/** `YYYY-MM-DD`. */
	approvedOn?: string;
	/** `YYYY-MM-DD`; set on approval and on each review. */
	lastReviewed?: string;
	/** Months between reviews. */
	reviewEvery?: number;
	/** Its outline (headings, no text) and length, stored on save and import. */
	sections?: Section[];
	words?: number;
}

export type Entry = Knowledge & {
	id: string;
	updatedBy?: string;
	url?: string;
	truncated?: boolean;
};

/** Today as `YYYY-MM-DD` (UTC). ISO dates compare as strings. */
const todayIso = () => new Date().toISOString().slice(0, 10);

export function isExpired(entry: { expiredAt?: string }, today = todayIso()): boolean {
	return !!entry.expiredAt && entry.expiredAt < today;
}

const statusOf = (e: Knowledge): Status => e.status ?? 'draft';
const audienceOf = (e: Knowledge): Audience => e.audience ?? 'internal';
/** How Claude gets it. Only an approved entry is "Always": a draft one is read when relevant. */
const useOf = (e: Knowledge): Use => {
	const use = e.use ?? 'relevant';
	return use === 'always' && statusOf(e) !== 'approved' ? 'relevant' : use;
};
/** Restricted entries are for admins only, in the Hub and through Claude. */
const visibleTo = (admin: boolean) => (e: Knowledge) => admin || audienceOf(e) !== 'restricted';
const isAdmin = (auth: any) => auth?.token?.role === 'admin';

/** An approved entry past its review date (`lastReviewed` + `reviewEvery` months). */
export function reviewDue(e: Knowledge, today = todayIso()): boolean {
	if (statusOf(e) !== 'approved') return false;
	if (!e.lastReviewed) return true;
	const d = new Date(`${e.lastReviewed}T00:00:00Z`);
	d.setUTCMonth(d.getUTCMonth() + (e.reviewEvery ?? DEFAULT_REVIEW_EVERY));
	return d.toISOString().slice(0, 10) <= today;
}

/**
 * Which entry wins when two disagree (docs/knowledge.md, "Precedence"): the type higher in TYPES,
 * then approved over draft, then the more recently approved or reviewed. Lower rank = stronger.
 */
export function rankOf(e: Knowledge): number {
	const t = TYPES.findIndex((x) => x.id === (e.type ?? 'other'));
	return (t < 0 ? TYPES.length : t) * 2 + (statusOf(e) === 'approved' ? 0 : 1) + 1;
}

/** The date an entry was last approved or reviewed, `YYYY-MM-DD` or ''. */
const reviewedOn = (e: Knowledge) => e.lastReviewed || e.approvedOn || '';
/** Its outline and length: stored, or worked out for an entry not saved since outlines exist. */
const outlineOf = (e: Knowledge): Section[] =>
	Array.isArray(e.sections) ? e.sections : sectionsOf(e.description ?? '', MAX_SECTIONS);
const wordsOf = (e: Knowledge) =>
	typeof e.words === 'number' ? e.words : wordCount(e.description ?? '');

/**
 * One entry as its own `<entry id="…" label="…" topics="…" valid_until="…">` block, text verbatim
 * inside, so Claude always sees where an entry starts and ends and its own bullets never run into
 * the next. With `part`, the block holds that one section and names it.
 */
function toEntry(entry: Knowledge & { id?: string }, part?: { section: Section; text: string }) {
	const attr = (s: string) => s.trim().replace(/"/g, "'");
	const label = entry.label ? attr(entry.label) : '';
	const topics = (entry.topics ?? []).map(attr).join(', ');
	const expiredAt = entry.expiredAt?.trim();
	const type = entry.type && entry.type !== 'other' ? entry.type : '';
	const useWhen = entry.useWhen ? attr(entry.useWhen) : '';
	const status = statusOf(entry);
	const decided = reviewedOn(entry);
	// An entry's own text can't close its block or open another (or the knowledge frame).
	const description = ((part ? part.text : entry.description)?.trim() ?? '').replace(
		/<(\/?)(entry|flf_knowledge)\b/gi,
		'‹$1$2'
	);
	if (!description) return label ? `<entry>\n${label}\n</entry>` : '';
	const attrs = [
		entry.id && ` id="${attr(entry.id)}"`,
		label && ` label="${label}"`,
		part && ` section="${part.section.id}" section_title="${attr(part.section.title)}"`,
		type && ` type="${type}"`,
		` rank="${rankOf(entry)}"`,
		` status="${status}"`,
		decided && ` reviewed="${decided}"`,
		useWhen && ` use_when="${useWhen}"`,
		audienceOf(entry) !== 'internal' && ` audience="${audienceOf(entry)}"`,
		topics && ` topics="${topics}"`,
		expiredAt && ` valid_until="${expiredAt}"`
	]
		.filter(Boolean)
		.join('');
	return `<entry${attrs}>\n${description}\n</entry>`;
}

/** What Claude reads Always: approved, use `always`, not expired. */
const isAlways = (today: string) => (e: Knowledge) => useOf(e) === 'always' && !isExpired(e, today);

/** The entries Claude always reads (use `always`, not expired), one `<entry>` each. */
export function formatKnowledge(entries: Entry[]): string {
	return entries
		.filter(isAlways(todayIso()))
		.sort((a, b) => rankOf(a) - rankOf(b))
		.map((e) => toEntry(e))
		.filter(Boolean)
		.join('\n\n');
}

/** Words of Always text: what every flf_get_knowledge carries (ALWAYS_BUDGET_WORDS is the aim). */
export function alwaysWords(entries: Knowledge[]): number {
	return entries.filter(isAlways(todayIso())).reduce((n, e) => n + wordsOf(e), 0);
}

/**
 * The index of the `relevant` entries Claude can ask for, grouped by type in precedence order.
 * Read on every flf_get_knowledge, so empty fields are left out and the outline is capped.
 */
export function relevantIndex(entries: Entry[]) {
	const today = todayIso();
	const rows = entries
		.filter((e) => useOf(e) === 'relevant' && !isExpired(e, today))
		.sort((a, b) => rankOf(a) - rankOf(b));
	const typeOf = (e: Knowledge) =>
		TYPES.some((t) => t.id === e.type) ? (e.type as KnowledgeType) : 'other';
	const row = (e: Entry) => {
		const outline = outlineOf(e);
		return {
			id: e.id,
			title: e.label || '(untitled)',
			type: typeOf(e),
			rank: rankOf(e),
			status: statusOf(e),
			...(e.useWhen ? { use_when: e.useWhen } : {}),
			...(e.topics?.length ? { topics: e.topics } : {}),
			words: wordsOf(e),
			// One section is the whole entry: no outline.
			...(outline.length > 1
				? { outline: outline.slice(0, INDEX_OUTLINE).map((s) => `${s.id}: ${s.title}`) }
				: {}),
			...(outline.length > INDEX_OUTLINE ? { outline_more: outline.length - INDEX_OUTLINE } : {}),
			...(reviewedOn(e) ? { reviewed: reviewedOn(e) } : {}),
			...(reviewDue(e, today) ? { review_due: true } : {}),
			...(audienceOf(e) !== 'internal' ? { audience: audienceOf(e) } : {})
		};
	};
	return TYPES.map((t) => ({
		type: t.id,
		label: t.label,
		entries: rows.filter((e) => typeOf(e) === t.id).map(row)
	})).filter((g) => g.entries.length);
}

/**
 * The text Claude asked for, never `off` or expired: whole entries (by id, or every one with a
 * topic) and single sections (`<entryId>#<sectionId>`), strongest rank first. `missing` lists what
 * was asked for and isn't there (unknown, off, expired or not visible), so Claude can say so.
 */
export function pick(
	entries: Entry[],
	ids: string[],
	topic: string,
	sections: string[] = []
): { text: string; missing: string[] } {
	const today = todayIso();
	const t = topic.trim().toLowerCase();
	const readable = entries.filter((e) => useOf(e) !== 'off' && !isExpired(e, today));
	const byId = new Map(readable.map((e) => [e.id, e]));
	// Asked for by id or topic, so given whatever its status: its status attribute says which.
	const whole = readable.filter(
		(e) => ids.includes(e.id) || (t && (e.topics ?? []).some((x) => x.toLowerCase() === t))
	);
	const wholeIds = new Set(whole.map((e) => e.id));
	const missing = ids.filter((id) => !byId.has(id));
	const blocks = whole.map((e, i) => ({ rank: rankOf(e), order: i, text: toEntry(e) }));
	for (const [i, ref] of [...new Set(sections)].entries()) {
		const at = ref.lastIndexOf('#');
		const e = at > 0 ? byId.get(ref.slice(0, at)) : undefined;
		// Already read whole in this call.
		if (e && wholeIds.has(e.id)) continue;
		const part = e ? sectionText(e.description, ref.slice(at + 1)) : null;
		if (!e || !part) {
			missing.push(ref);
			continue;
		}
		blocks.push({ rank: rankOf(e), order: whole.length + i, text: toEntry(e, part) });
	}
	const text = blocks
		.sort((a, b) => a.rank - b.rank || a.order - b.order)
		.map((b) => b.text)
		.filter(Boolean)
		.join('\n\n');
	return { text, missing };
}

export async function list(): Promise<Entry[]> {
	const snap = await collection.orderBy('createdAt').limit(MAX_ENTRIES).get();
	return snap.docs.map((d) => {
		const x = d.data();
		return {
			id: d.id,
			label: x.label ?? '',
			description: x.description ?? '',
			expiredAt: x.expiredAt ?? '',
			use: (x.use as Use) ?? 'relevant',
			topics: x.topics ?? [],
			source: x.source === 'drive' ? 'drive' : 'hub',
			url: x.url ?? '',
			truncated: x.truncated === true,
			updatedBy: x.updatedBy ?? '',
			type: (x.type as KnowledgeType) ?? 'other',
			useWhen: x.useWhen ?? '',
			audience: (x.audience as Audience) ?? 'internal',
			status: (x.status as Status) ?? 'draft',
			approvedBy: x.approvedBy ?? '',
			approvedOn: x.approvedOn ?? '',
			lastReviewed: x.lastReviewed ?? '',
			reviewEvery: x.reviewEvery ?? DEFAULT_REVIEW_EVERY,
			sections: outlineOf({ description: x.description ?? '', sections: x.sections }),
			words: wordsOf({ description: x.description ?? '', words: x.words })
		};
	});
}

/** The outline and word count stored with a text (on save, import and the nightly backfill). */
const outlineFields = (text: string) => ({
	sections: sectionsOf(text, MAX_SECTIONS),
	words: wordCount(text)
});

const who = (auth: any) => {
	const name = auth?.token?.name || auth?.token?.email || 'System';
	return callVia() === 'claude' ? `${name} · via Claude` : name;
};

function cleanUse(p: any): { use: Use; topics: string[] } {
	const use = (p?.use ?? 'relevant') as Use;
	if (!USES.some((u) => u.id === use))
		throw new HttpsError('invalid-argument', 'Pick how Claude uses it: always, relevant or off.');
	const topics = Array.isArray(p?.topics)
		? [...new Set(p.topics.map((t: unknown) => String(t).trim()).filter(Boolean))]
		: [];
	if (topics.length > MAX_TOPICS || topics.some((t) => (t as string).length > MAX_TOPIC))
		throw new HttpsError(
			'invalid-argument',
			`Use at most ${MAX_TOPICS} topics of ${MAX_TOPIC} characters.`
		);
	return { use, topics: topics as string[] };
}

/**
 * The entry's card from the payload, checked; `prev` is what is stored. Approving (or marking it
 * reviewed) is for people: Claude can propose a card but not approve one. Only an approved entry
 * can be "Always".
 */
function cleanCard(p: any, prev: Knowledge | undefined, auth: any, use: Use) {
	const type = (p?.type ?? prev?.type ?? 'other') as KnowledgeType;
	if (!TYPES.some((t) => t.id === type)) throw new HttpsError('invalid-argument', 'Pick a type.');
	const useWhen = str(p?.useWhen ?? prev?.useWhen ?? '', 'useWhen', false);
	if (useWhen.length > MAX_USE_WHEN)
		throw new HttpsError('invalid-argument', `Keep "Use when" under ${MAX_USE_WHEN} characters.`);
	const audience = (p?.audience ?? prev?.audience ?? 'internal') as Audience;
	if (!AUDIENCES.some((a) => a.id === audience))
		throw new HttpsError('invalid-argument', 'Pick an audience: external, internal or restricted.');
	const status = (p?.status ?? prev?.status ?? 'draft') as Status;
	if (!STATUSES.some((x) => x.id === status))
		throw new HttpsError('invalid-argument', 'Pick a status: draft or approved.');
	const reviewEvery = Number(p?.reviewEvery ?? prev?.reviewEvery ?? DEFAULT_REVIEW_EVERY);
	if (!(REVIEW_EVERY as readonly number[]).includes(reviewEvery))
		throw new HttpsError('invalid-argument', `Review every ${REVIEW_EVERY.join(', ')} months.`);
	let status2 = status;
	// Making an approved entry shareable outside FLF takes a person's approval again.
	if (
		status === 'approved' &&
		prev?.status === 'approved' &&
		audience === 'external' &&
		(prev.audience ?? 'internal') !== 'external' &&
		p?.status !== 'approved'
	)
		status2 = 'draft';
	const approving = status2 === 'approved' && prev?.status !== 'approved';
	const reviewing = p?.reviewed === true && status2 === 'approved';
	if ((approving || reviewing) && callVia() === 'claude')
		throw new HttpsError(
			'permission-denied',
			'Only a person approves or reviews knowledge: ask them to do it on the Knowledge page.'
		);
	// Always only on an approved entry: asked for explicitly on a draft, it's refused; kept from before
	// (the entry went back to draft), it quietly becomes When relevant.
	if (use === 'always' && status2 !== 'approved' && p?.use === 'always' && p?.useExplicit)
		throw new HttpsError('failed-precondition', 'Approve the entry before setting it to Always.');
	const today = todayIso();
	const approval =
		status2 === 'approved'
			? {
					approvedBy: approving ? who(auth) : (prev?.approvedBy ?? who(auth)),
					approvedOn: approving ? today : (prev?.approvedOn ?? today),
					lastReviewed: approving || reviewing ? today : (prev?.lastReviewed ?? today)
				}
			: { approvedBy: '', approvedOn: '', lastReviewed: '' };
	return {
		type,
		useWhen,
		audience,
		status: status2,
		reviewEvery,
		...approval,
		...(use === 'always' && status2 !== 'approved' ? { use: 'relevant' as Use } : {})
	};
}

function clean(p: any) {
	const description = str(p?.description, 'description');
	if (description.length > MAX_DESCRIPTION)
		throw new HttpsError(
			'invalid-argument',
			`The description is too long (${MAX_DESCRIPTION} characters at most).`
		);
	const label = str(p?.label, 'label', false);
	if (label.length > MAX_LABEL)
		throw new HttpsError(
			'invalid-argument',
			`Shorten the label to ${MAX_LABEL} characters or fewer.`
		);
	const expiredAt = str(p?.expiredAt, 'expiredAt', false);
	if (expiredAt && !/^\d{4}-\d{2}-\d{2}$/.test(expiredAt))
		throw new HttpsError('invalid-argument', 'Pick a valid expiry date.');
	return { label, description, expiredAt, ...cleanUse(p) };
}

// ------------------------------------------------------------------ the Knowledge Drive folder

const DOC = 'application/vnd.google-apps.document';
/** What the import can read as text: Google Docs (exported) and plain text or Markdown files. */
export const READABLE = [DOC, 'text/plain', 'text/markdown', 'text/x-markdown'];

export interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	modifiedTime: string;
	webViewLink: string;
	/** The subfolders it sits in, from the listed folder down ([] at the top). */
	path: string[];
}

const FOLDER = 'application/vnd.google-apps.folder';
const SHORTCUT = 'application/vnd.google-apps.shortcut';
/** How deep a listing goes into subfolders (the listed folder is level 0). */
const MAX_DEPTH = 4;

async function drive() {
	const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
	return auth.getClient();
}

async function folderId(): Promise<string> {
	const s = (await db.collection('connection').doc('knowledge-folder').get()).data()?.settings;
	return String(s?.folderId ?? '').trim() || DEFAULT_FOLDER_ID;
}

/** What a Drive folder walk found. */
export interface FolderListing {
	folderId: string;
	files: DriveFile[];
	/** False when the listing stopped early: then nothing may be removed for being absent. */
	complete: boolean;
	/** Shortcuts to folders the Hub can't open (not shared with it), by path. */
	unshared: string[];
	/** Subfolders walked (shortcuts to folders included). */
	folders: number;
}

/** The Knowledge folder's files, its subfolders' included. Read only. */
export async function listFolder(): Promise<FolderListing> {
	return listDriveFolder(await folderId(), 'Knowledge folder', MAX_ENTRIES);
}

/**
 * A Drive folder's files, its subfolders' included (up to MAX_DEPTH levels, shortcuts followed),
 * not trashed, at most `max`. Read only. `name` is how errors call the folder ("Knowledge folder").
 * Also used by Skills (docs/skills.md).
 */
export async function listDriveFolder(
	id: string,
	name: string,
	max: number
): Promise<FolderListing> {
	const client = await drive();
	// An unshared folder lists as empty, not as an error: look at the folder itself first.
	try {
		const f = await client.request<{ mimeType?: string }>({
			url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=mimeType&supportsAllDrives=true`
		});
		if (f.data.mimeType !== 'application/vnd.google-apps.folder')
			throw new HttpsError('failed-precondition', `The ${name} id is not a folder.`);
	} catch (err) {
		if (err instanceof HttpsError) throw err;
		const res = (err as { response?: { status?: number; data?: unknown } }).response;
		const status = res?.status;
		// A 403 is either the folder not shared or the Drive API off in the project: tell them apart.
		const body = JSON.stringify(res?.data ?? '');
		let message: string;
		if (status === 403 && /SERVICE_DISABLED|accessNotConfigured|has not been used/.test(body))
			message =
				'The Google Drive API is off in the Hub’s Google Cloud project: a developer enables it (APIs & Services → Google Drive API → Enable).';
		else if (status === 404 || status === 403)
			message = `The Hub can't see the ${name} (${id}): share that folder with 900685987021-compute@developer.gserviceaccount.com as Viewer, or put the right folder id on Connections.`;
		else message = `Drive answered ${status ?? 'with an error'} for the ${name}.`;
		throw new HttpsError('failed-precondition', message);
	}
	const files: DriveFile[] = [];
	let complete = true;
	const queue: { id: string; path: string[]; shortcut?: boolean }[] = [{ id, path: [] }];
	const unshared: string[] = [];
	// A shortcut can point back up the tree: each folder is walked once.
	const seen = new Set([id]);
	const seenFiles = new Set<string>();
	while (queue.length) {
		const folder = queue.shift()!;
		// A shortcut's target keeps its own sharing: a folder the Hub can't open lists as empty, so
		// look at it first and report it rather than import nothing in silence.
		if (folder.shortcut) {
			try {
				await client.request({
					url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folder.id)}?fields=id&supportsAllDrives=true`
				});
			} catch {
				unshared.push(folder.path.join(' / '));
				complete = false;
				continue;
			}
		}
		let pageToken = '';
		do {
			const params = new URLSearchParams({
				q: `'${folder.id.replace(/'/g, '')}' in parents and trashed = false`,
				fields:
					'nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink, shortcutDetails)',
				pageSize: '200',
				supportsAllDrives: 'true',
				includeItemsFromAllDrives: 'true',
				...(pageToken ? { pageToken } : {})
			});
			const res = await client.request<{
				files?: (Omit<DriveFile, 'path'> & {
					shortcutDetails?: { targetId: string; targetMimeType: string };
				})[];
				nextPageToken?: string;
			}>({ url: `https://www.googleapis.com/drive/v3/files?${params}` });
			for (const raw of res.data.files ?? []) {
				// A shortcut stands for its target: a folder to walk or a file to read.
				const t = raw.mimeType === SHORTCUT ? raw.shortcutDetails : undefined;
				const f = t ? { ...raw, id: t.targetId, mimeType: t.targetMimeType } : raw;
				// A file can sit in two places (itself and a shortcut to it): keep the first only, or
				// the second would be imported as a new entry over the first one's card.
				if (f.mimeType !== FOLDER) {
					if (!seenFiles.has(f.id)) files.push({ ...f, path: folder.path });
					seenFiles.add(f.id);
				} else if (seen.has(f.id)) continue;
				else if (folder.path.length < MAX_DEPTH) {
					seen.add(f.id);
					queue.push({ id: f.id, path: [...folder.path, f.name], shortcut: !!t });
				} else complete = false;
			}
			pageToken = res.data.nextPageToken ?? '';
			if (files.length >= max) {
				return {
					folderId: id,
					files: files.slice(0, max),
					complete: false,
					unshared,
					folders: seen.size - 1
				};
			}
		} while (pageToken);
	}
	return { folderId: id, files, complete, unshared, folders: seen.size - 1 };
}

/** How a file's text was read: a Google Doc as Markdown (or plain text when Drive refused), else as it is. */
export type ExportFormat = 'markdown' | 'plain' | 'file';

/**
 * A readable file's text. Read only. With `markdown`, a Google Doc is exported as Markdown, so its
 * headings make the entry's sections; if Drive refuses that export, as plain text. Text and
 * Markdown files are read as they are.
 */
export async function readDriveFile(
	f: DriveFile,
	markdown: boolean
): Promise<{ text: string; format: ExportFormat }> {
	const client = await drive();
	const get = async (url: string) =>
		String((await client.request<string>({ url, responseType: 'text' })).data ?? '')
			.replace(/^\uFEFF/, '')
			.replace(/\r\n/g, '\n')
			.trim();
	if (f.mimeType !== DOC)
		return {
			text: await get(
				`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media&supportsAllDrives=true`
			),
			format: 'file'
		};
	const exportUrl = (mime: string) =>
		`https://www.googleapis.com/drive/v3/files/${f.id}/export?mimeType=${encodeURIComponent(mime)}`;
	if (markdown) {
		try {
			return { text: await get(exportUrl('text/markdown')), format: 'markdown' };
		} catch (err) {
			// Only Drive answering no falls back; a network failure is thrown as it is.
			if (!(err as { response?: unknown }).response) throw err;
		}
	}
	return { text: await get(exportUrl('text/plain')), format: 'plain' };
}

/** A readable file's text, a Google Doc as plain text (Skills, docs/skills.md). Read only. */
export async function textOf(f: DriveFile): Promise<string> {
	return (await readDriveFile(f, false)).text;
}

/**
 * Import the Knowledge folder: each readable file becomes (or updates) the entry `drive-<id>`;
 * a file gone from the folder takes its entry with it. The text is re-read only when the file
 * changed. The team's choices on an entry (use, topics, expiry) survive every import; a new import
 * starts as `relevant`, since documents can be long. Never writes to Drive.
 */
export async function importFolder() {
	// Every entry (the list is settings-sized), read before Drive so entries from before the card get
	// their defaults even when the folder can't be read (the Knowledge page's audience query needs them),
	// and entries from before outlines get theirs. Written only when a field is missing.
	const all = (await collection.get()).docs;
	const noOutline = (x: FirebaseFirestore.DocumentData) =>
		!Array.isArray(x.sections) || typeof x.words !== 'number';
	for (const d of all.filter((x) => !x.data().audience || !x.data().status || noOutline(x.data())))
		await d.ref.set(
			{
				audience: d.data().audience ?? 'internal',
				status: d.data().status ?? 'draft',
				type: d.data().type ?? 'other',
				...(noOutline(d.data()) ? outlineFields(d.data().description ?? '') : {})
			},
			{ merge: true }
		);
	const { folderId: id, files, complete, unshared } = await listFolder();
	const importable = files.filter((f) => READABLE.includes(f.mimeType));
	const where = (f: DriveFile) => [...f.path, f.name].join(' / ');
	const skipped = [
		...files.filter((f) => !READABLE.includes(f.mimeType)).map(where),
		...unshared.map(
			(p) =>
				`${p} (a shortcut to a folder not shared with 900685987021-compute@developer.gserviceaccount.com)`
		)
	];
	if (!complete)
		skipped.push(
			`The folder wasn't read whole (over ${MAX_ENTRIES} files, folders deeper than ${MAX_DEPTH} levels, or a shortcut the Hub can't open): nothing was removed`
		);
	const existing = new Map(
		all.filter((d) => d.data().source === 'drive').map((d) => [d.id, d.data()])
	);
	// Knowledge holds MAX_ENTRIES in all: documents already imported are updated; new ones only fill
	// the room left.
	const known = importable.filter((f) => existing.has(`${DRIVE_PREFIX}${f.id}`));
	const fresh = importable.filter((f) => !existing.has(`${DRIVE_PREFIX}${f.id}`));
	const room = Math.max(0, MAX_ENTRIES - all.length);
	const readable = [...known, ...fresh.slice(0, room)];
	if (fresh.length > room)
		skipped.push(
			`${fresh.length - room} documents over the ${MAX_ENTRIES}-entry limit (not imported)`
		);
	let added = 0;
	let updated = 0;
	for (const f of readable) {
		const docId = `${DRIVE_PREFIX}${f.id}`;
		const prev = existing.get(docId);
		existing.delete(docId);
		const folderType = typeOfFolder(f.path[0]);
		if (
			prev &&
			prev.driveModifiedTime === f.modifiedTime &&
			prev.label === f.name.slice(0, MAX_LABEL) &&
			(prev.typeSet || prev.type === folderType) &&
			// A Google Doc imported before Markdown export is read once more, for its headings.
			(f.mimeType !== DOC || prev.exportFormat)
		)
			continue;
		// A shortcut to a file not shared with the Hub can't be read: report it, import the rest.
		let text: string;
		let exportFormat: ExportFormat;
		try {
			({ text, format: exportFormat } = await readDriveFile(f, true));
		} catch {
			// Kept if it was imported before (it was taken off the removal list above).
			skipped.push(`${where(f)} (can't be read: not shared with the Hub)`);
			continue;
		}
		// Its type from its top subfolder, unless the team set one in the Hub.
		// Its type follows its folder (moved from Brand to Legal = a policy) unless a person set one.
		const type = prev?.typeSet && prev.type ? prev.type : folderType;
		const description = text.slice(0, MAX_IMPORTED);
		const body = {
			label: f.name.slice(0, MAX_LABEL),
			type,
			description,
			truncated: text.length > MAX_IMPORTED,
			...outlineFields(description),
			source: 'drive',
			url: f.webViewLink,
			driveModifiedTime: f.modifiedTime,
			exportFormat,
			updatedBy: 'Drive import',
			updatedAt: serverTimestamp()
		};
		if (prev) {
			// Its text or its type (folder) changed: a person approves it again (until then not "Always").
			const changed = prev.driveModifiedTime !== f.modifiedTime || prev.type !== type;
			await collection.doc(docId).set(
				changed && prev.status === 'approved'
					? {
							...body,
							status: 'draft',
							approvedBy: '',
							approvedOn: '',
							lastReviewed: '',
							...(prev.use === 'always' ? { use: 'relevant' } : {})
						}
					: body,
				{ merge: true }
			);
			updated++;
		} else {
			await collection.doc(docId).set({
				...body,
				expiredAt: '',
				use: 'relevant',
				useWhen: '',
				audience: 'internal',
				status: 'draft',
				reviewEvery: DEFAULT_REVIEW_EVERY,
				// Its top subfolder ("Legal", "Scoring"…) is a topic Claude can ask for.
				topics: f.path.length ? [f.path[0].slice(0, 30)] : [],
				createdAt: serverTimestamp()
			});
			added++;
		}
	}
	// What's left was deleted from (or moved out of) the folder; only after a whole listing.
	// Not after a capped import either: the documents left out are still in the folder.
	const whole = complete && fresh.length <= room;
	if (whole) for (const docId of existing.keys()) await collection.doc(docId).delete();
	const removed = whole ? existing.size : 0;
	await db
		.collection('connection')
		.doc('knowledge-folder')
		.set(
			{ lastSyncAt: serverTimestamp(), lastSync: { added, updated, removed, skipped } },
			{ merge: true }
		);
	logger.log(`import ${JSON.stringify({ folderId: id, added, updated, removed, skipped })}`);
	return { files: files.length, imported: readable.length, added, updated, removed, skipped };
}

// ------------------------------------------------------------------ gaps

/**
 * Knowledge found missing, contradictory or out of date (docs/knowledge.md, "Gaps"), reported by
 * Claude while it reads or by a person, and resolved on the Knowledge page.
 */
export const gaps = db.collection(GAP_COLLECTION);

/**
 * Record a gap. The same kind, entries and query (or, with neither, the same note) already open
 * from the last GAP_REPEAT_DAYS only gets its count bumped, so Claude meeting the same hole in
 * every conversation makes one row. Reads: the named entries (at most MAX_GAP_ENTRIES, to refuse
 * ids that don't exist or the reporter can't see) and one `limit(1)` query for the repeat.
 */
async function reportGap(p: any, auth: any) {
	const kind = p?.kind as GapKind;
	if (!GAP_KINDS.some((k) => k.id === kind))
		throw new HttpsError('invalid-argument', 'Pick a kind: missing, conflict or outdated.');
	const note = str(p?.note, 'note');
	if (note.length > MAX_GAP_NOTE)
		throw new HttpsError('invalid-argument', `Keep the note under ${MAX_GAP_NOTE} characters.`);
	const query = str(p?.query, 'query', false);
	if (query.length > MAX_GAP_QUERY)
		throw new HttpsError('invalid-argument', `Keep the query under ${MAX_GAP_QUERY} characters.`);
	const entryIds = Array.isArray(p?.entryIds)
		? [...new Set<string>(p.entryIds.map((x: unknown) => String(x).trim()).filter(Boolean))].sort()
		: [];
	if (entryIds.length > MAX_GAP_ENTRIES)
		throw new HttpsError('invalid-argument', `Name at most ${MAX_GAP_ENTRIES} entries.`);
	if (kind !== 'missing' && !entryIds.length)
		throw new HttpsError('invalid-argument', 'Name the entries that conflict or are out of date.');
	if (entryIds.length) {
		const docs = await db.getAll(...entryIds.map((id) => collection.doc(id)));
		const unknown = docs
			.filter((d) => !d.exists || !visibleTo(isAdmin(auth))(d.data() as Knowledge))
			.map((d) => d.id);
		if (unknown.length)
			throw new HttpsError('not-found', `No knowledge entry ${unknown.join(', ')}.`);
	}
	const norm = (s: string) => fold(s).replace(/\s+/g, ' ').trim();
	const key = createHash('sha256')
		.update(
			JSON.stringify([kind, entryIds, norm(query), entryIds.length || query ? '' : norm(note)])
		)
		.digest('hex')
		.slice(0, 32);
	const by = who(auth);
	const since = new Date(Date.now() - GAP_REPEAT_DAYS * 86_400_000);
	const open = await gaps
		.where('key', '==', key)
		.where('status', '==', 'open')
		.where('createdAt', '>=', since)
		.limit(1)
		.get();
	if (!open.empty) {
		const d = open.docs[0];
		await d.ref.update({
			count: increment(1),
			lastReportedAt: serverTimestamp(),
			lastReportedBy: by
		});
		logger.log(`gap ${d.id} reported again`);
		return { id: d.id, repeated: true, count: (d.data().count ?? 1) + 1 };
	}
	const added = await gaps.add({
		kind,
		note,
		entryIds,
		query,
		key,
		reportedBy: by,
		reportedUid: auth?.uid ?? '',
		via: callVia() === 'claude' ? 'claude' : 'hub',
		status: 'open',
		count: 1,
		resolvedBy: '',
		resolution: '',
		createdAt: serverTimestamp(),
		resolvedAt: null
	});
	logger.log(`gap ${added.id} reported (${kind})`);
	return { id: added.id, repeated: false, count: 1 };
}

/** Close a gap, with an optional note on what was done. */
async function resolveGap(p: any, auth: any) {
	const id = str(p?.id, 'id');
	const note = str(p?.note, 'note', false);
	if (note.length > MAX_GAP_NOTE)
		throw new HttpsError('invalid-argument', `Keep the note under ${MAX_GAP_NOTE} characters.`);
	const ref = gaps.doc(id);
	const stored = (await ref.get()).data();
	if (!stored) throw new HttpsError('not-found', 'Gap not found.');
	if (stored.status === 'resolved') return { id, resolved: true };
	await ref.update({
		status: 'resolved',
		resolvedBy: who(auth),
		resolution: note,
		resolvedAt: serverTimestamp()
	});
	logger.log(`gap ${id} resolved`);
	return { id, resolved: true };
}

// ------------------------------------------------------------------ actions

export const actions = {
	/** Every entry, oldest first; the always-on block and the index of the relevant ones. */
	list: async (_p: any, auth: any) => {
		const entries = (await list()).filter(visibleTo(isAdmin(auth)));
		const today = todayIso();
		const folder = await folderId();
		return {
			// Without the texts (up to 50,000 characters each) or outlines: the page reads them from
			// Firestore, Claude gets the outlines in `relevant`.
			entries: entries.map((e) => {
				const { description, sections, ...rest } = e;
				return {
					...rest,
					chars: description.length,
					sectionCount: sections?.length ?? 0,
					rank: rankOf(e),
					expired: isExpired(e, today),
					reviewDue: reviewDue(e, today)
				};
			}),
			active: formatKnowledge(entries),
			relevant: relevantIndex(entries),
			alwaysWords: alwaysWords(entries),
			alwaysBudget: ALWAYS_BUDGET_WORDS,
			folder: { id: folder, url: `https://drive.google.com/drive/folders/${folder}` },
			uses: USES,
			types: TYPES,
			audiences: AUDIENCES,
			statuses: STATUSES,
			reviewEvery: REVIEW_EVERY,
			gapKinds: GAP_KINDS
		};
	},

	/**
	 * The text of chosen entries: whole by `ids` or `topic`, or single `sections`
	 * (`<entryId>#<sectionId>`, from the index's outline or a search hit).
	 */
	get: async (p: any, auth: any) => {
		const ids = Array.isArray(p?.ids) ? p.ids.map(String).slice(0, 50) : [];
		const topic = str(p?.topic, 'topic', false);
		const sections = Array.isArray(p?.sections) ? p.sections.map(String) : [];
		if (sections.length > MAX_READ_SECTIONS)
			throw new HttpsError(
				'invalid-argument',
				`Ask for at most ${MAX_READ_SECTIONS} sections at a time.`
			);
		if (!ids.length && !topic && !sections.length)
			throw new HttpsError('invalid-argument', 'Give ids, sections or a topic.');
		return pick((await list()).filter(visibleTo(isAdmin(auth))), ids, topic, sections);
	},

	/**
	 * The sections that best match `query` (title, Use when and topics count more than the text;
	 * ties go to the stronger rank), each with a snippet. In memory over the list: no query of its
	 * own. Never off, expired or (for anyone but admins) restricted entries.
	 */
	search: async (p: any, auth: any) => {
		const query = str(p?.query, 'query');
		if (query.length > 200)
			throw new HttpsError('invalid-argument', 'Keep the query under 200 characters.');
		const limit = Math.min(Math.max(Number(p?.limit) || 5, 1), MAX_RESULTS);
		const today = todayIso();
		const entries = (await list())
			.filter(visibleTo(isAdmin(auth)))
			.filter((e) => useOf(e) !== 'off' && !isExpired(e, today));
		const hits = searchEntries(
			entries.map((e) => ({ ...e, rank: rankOf(e) })),
			query,
			limit
		);
		return { query, hits };
	},

	'gap.report': async (p: any, auth: any) => reportGap(p, auth),
	'gap.resolve': async (p: any, auth: any) => resolveGap(p, auth),

	/**
	 * Create (no id) or update an entry; returns its id. On an imported entry its card, use, topics
	 * and expiry change; its title and text come from Drive.
	 */
	save: async (p: any, auth: any) => {
		const id = str(p?.id, 'id', false);
		let entry = p?.entry ?? {};
		const ref = id ? collection.doc(id) : null;
		let imported = false;
		let stored: (Knowledge & Record<string, any>) | undefined;
		if (ref) {
			// Editing: fields not sent keep their stored value (Claude may send only the one it changes).
			stored = (await ref.get()).data() as (Knowledge & Record<string, any>) | undefined;
			if (!stored) throw new HttpsError('not-found', 'Entry not found.');
			// A restricted entry doesn't exist for anyone else.
			if (!visibleTo(isAdmin(auth))(stored)) throw new HttpsError('not-found', 'Entry not found.');
			imported = stored.source === 'drive';
			const sent = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined));
			entry = {
				label: stored.label,
				description: stored.description,
				expiredAt: stored.expiredAt,
				use: stored.use,
				topics: stored.topics,
				...sent,
				...(imported ? { label: stored.label, description: stored.description } : {})
			};
		}
		// Always asked for in this call (not just kept from before): refused on a draft.
		const useExplicit = p?.entry?.use === 'always';
		let card = cleanCard({ ...entry, useExplicit }, stored, auth, cleanUse(entry).use);
		// What makes an entry say something else (its text, title or type, which sets its rank) takes
		// a person's approval again, whoever edits it: an approved entry can't be rewritten in place.
		if (stored && stored.status === 'approved' && card.status === 'approved' && !entry.reviewed) {
			const changed =
				(!imported &&
					((entry.description ?? '') !== (stored.description ?? '') ||
						(entry.label ?? '') !== (stored.label ?? ''))) ||
				card.type !== (stored.type ?? 'other');
			if (changed)
				card = {
					...card,
					status: 'draft',
					approvedBy: '',
					approvedOn: '',
					lastReviewed: '',
					// A draft isn't read Always.
					...(cleanUse(entry).use === 'always' ? { use: 'relevant' as Use } : {})
				};
		}
		// A type chosen in the Hub (or by Claude) sticks; otherwise the import follows the folder.
		const typeSet =
			entry.type !== undefined && entry.type !== (stored?.type ?? undefined)
				? { typeSet: true }
				: {};
		if (card.audience === 'restricted' && !isAdmin(auth))
			throw new HttpsError('permission-denied', 'Only admins can make an entry restricted.');
		const meta = { updatedBy: who(auth), updatedAt: serverTimestamp() };
		if (ref && imported) {
			const expiredAt = str(entry.expiredAt, 'expiredAt', false);
			if (expiredAt && !/^\d{4}-\d{2}-\d{2}$/.test(expiredAt))
				throw new HttpsError('invalid-argument', 'Pick a valid expiry date.');
			// The import's own stamp stays: a Hub edit here is not a change in Drive.
			await ref.set(
				{ ...cleanUse(entry), ...card, ...typeSet, expiredAt, updatedAt: meta.updatedAt },
				{ merge: true }
			);
			logger.log(`updated card of ${id}`);
			return { id };
		}
		const cleaned = clean(entry);
		const body = {
			...cleaned,
			...outlineFields(cleaned.description),
			...card,
			...typeSet,
			source: 'hub',
			...meta
		};
		if (ref) {
			await ref.set(body, { merge: true });
			logger.log(`updated ${id}`);
			return { id };
		}
		if ((await collection.count().get()).data().count >= MAX_ENTRIES)
			throw new HttpsError(
				'resource-exhausted',
				`Knowledge is full (${MAX_ENTRIES} entries). Delete expired entries to add new ones.`
			);
		const added = await collection.add({ ...body, createdAt: serverTimestamp() });
		logger.log(`created ${added.id}`);
		return { id: added.id };
	},

	/** Delete an entry written in the Hub (an imported one goes when its file leaves the folder). */
	delete: async (p: any, auth: any) => {
		const id = str(p?.id, 'id');
		const ref = collection.doc(id);
		const stored = (await ref.get()).data() as Knowledge | undefined;
		if (!stored || !visibleTo(isAdmin(auth))(stored))
			throw new HttpsError('not-found', 'Entry not found.');
		if (stored.source === 'drive')
			throw new HttpsError(
				'failed-precondition',
				'This entry comes from the Knowledge folder in Drive: remove the file there, or set it to Off.'
			);
		await ref.delete();
		logger.log(`deleted ${id}`);
		return { ok: true };
	},

	/** Import the Knowledge Drive folder now (read only on Drive). */
	sync: async () => importFolder()
};
