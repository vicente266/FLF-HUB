import { HttpsError } from 'firebase-functions/v2/https';
import { GoogleAuth } from 'google-auth-library';
import { db } from '../../firestore';
import { callVia } from '../call-context';
import { createLogger, serverTimestamp, str } from '../utils';
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
	typeOfFolder,
	type Use,
	type KnowledgeType,
	type Audience,
	type Status
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

/**
 * One entry as its own `<entry label="…" topics="…" valid_until="…">` block, text verbatim inside,
 * so Claude always sees where an entry starts and ends and its own bullets never run into the next.
 */
function toEntry(entry: Knowledge): string {
	const attr = (s: string) => s.trim().replace(/"/g, "'");
	const label = entry.label ? attr(entry.label) : '';
	const topics = (entry.topics ?? []).map(attr).join(', ');
	const expiredAt = entry.expiredAt?.trim();
	const type = entry.type && entry.type !== 'other' ? entry.type : '';
	const useWhen = entry.useWhen ? attr(entry.useWhen) : '';
	const status = statusOf(entry);
	const decided = entry.lastReviewed || entry.approvedOn || '';
	// An entry's own text can't close its block or open another (or the knowledge frame).
	const description = (entry.description?.trim() ?? '').replace(
		/<(\/?)(entry|flf_knowledge)\b/gi,
		'‹$1$2'
	);
	if (!description) return label ? `<entry>\n${label}\n</entry>` : '';
	const attrs = [
		label && ` label="${label}"`,
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

/** The entries Claude always reads (use `always`, not expired), one `<entry>` each. */
export function formatKnowledge(entries: Knowledge[]): string {
	const today = todayIso();
	return entries
		.filter((e) => useOf(e) === 'always' && !isExpired(e, today))
		.sort((a, b) => rankOf(a) - rankOf(b))
		.map(toEntry)
		.filter(Boolean)
		.join('\n\n');
}

/** The `relevant` entries Claude can ask for: id, title and topics only. */
export function relevantIndex(entries: Entry[]) {
	const today = todayIso();
	return entries
		.filter((e) => useOf(e) === 'relevant' && !isExpired(e, today))
		.sort((a, b) => rankOf(a) - rankOf(b))
		.map((e) => ({
			id: e.id,
			label: e.label || '(untitled)',
			type: e.type ?? 'other',
			rank: rankOf(e),
			status: statusOf(e),
			useWhen: e.useWhen ?? '',
			topics: e.topics ?? []
		}));
}

/** The full text of the chosen entries (by id, or every one with a topic), never `off` or expired. */
export function pick(entries: Entry[], ids: string[], topic: string): string {
	const today = todayIso();
	const t = topic.trim().toLowerCase();
	// Asked for by id or topic, so given whatever its status: its status attribute says which.
	return entries
		.filter((e) => useOf(e) !== 'off' && !isExpired(e, today))
		.filter((e) => ids.includes(e.id) || (t && (e.topics ?? []).some((x) => x.toLowerCase() === t)))
		.sort((a, b) => rankOf(a) - rankOf(b))
		.map(toEntry)
		.filter(Boolean)
		.join('\n\n');
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
			reviewEvery: x.reviewEvery ?? DEFAULT_REVIEW_EVERY
		};
	});
}

/** The always-on block (empty string when none), read fresh so expiry is honoured. */
export async function activeText(auth?: any): Promise<string> {
	return formatKnowledge((await list()).filter(visibleTo(isAdmin(auth))));
}

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
	const approving = status === 'approved' && prev?.status !== 'approved';
	const reviewing = p?.reviewed === true && status === 'approved';
	if ((approving || reviewing) && callVia() === 'claude')
		throw new HttpsError(
			'permission-denied',
			'Only a person approves or reviews knowledge: ask them to do it on the Knowledge page.'
		);
	if (use === 'always' && status !== 'approved')
		throw new HttpsError('failed-precondition', 'Approve the entry before setting it to Always.');
	const today = todayIso();
	const approval =
		status === 'approved'
			? {
					approvedBy: approving ? who(auth) : (prev?.approvedBy ?? who(auth)),
					approvedOn: approving ? today : (prev?.approvedOn ?? today),
					lastReviewed: approving || reviewing ? today : (prev?.lastReviewed ?? today)
				}
			: { approvedBy: '', approvedOn: '', lastReviewed: '' };
	return { type, useWhen, audience, status, reviewEvery, ...approval };
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
const READABLE = [DOC, 'text/plain', 'text/markdown', 'text/x-markdown'];

interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	modifiedTime: string;
	webViewLink: string;
	/** The subfolders it sits in, from the Knowledge folder down ([] at the top). */
	path: string[];
}

const FOLDER = 'application/vnd.google-apps.folder';
const SHORTCUT = 'application/vnd.google-apps.shortcut';
/** How deep the import goes into subfolders (the Knowledge folder is level 0). */
const MAX_DEPTH = 4;

async function drive() {
	const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
	return auth.getClient();
}

async function folderId(): Promise<string> {
	const s = (await db.collection('connection').doc('knowledge-folder').get()).data()?.settings;
	return String(s?.folderId ?? '').trim() || DEFAULT_FOLDER_ID;
}

/**
 * The folder's files, its subfolders' included (up to MAX_DEPTH levels), not trashed. Read only.
 * `complete` is false when the listing stopped early: then nothing may be removed for being absent.
 */
export async function listFolder(): Promise<{
	folderId: string;
	files: DriveFile[];
	complete: boolean;
	/** Shortcuts to folders the Hub can't open (not shared with it), by path. */
	unshared: string[];
	/** Subfolders walked (shortcuts to folders included). */
	folders: number;
}> {
	const id = await folderId();
	const client = await drive();
	// An unshared folder lists as empty, not as an error: look at the folder itself first.
	try {
		const f = await client.request<{ mimeType?: string }>({
			url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=mimeType&supportsAllDrives=true`
		});
		if (f.data.mimeType !== 'application/vnd.google-apps.folder')
			throw new HttpsError('failed-precondition', 'The Knowledge folder id is not a folder.');
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
			message = `The Hub can't see the Knowledge folder (${id}): share that folder with 900685987021-compute@developer.gserviceaccount.com as Viewer, or put the right folder id on Connections.`;
		else message = `Drive answered ${status ?? 'with an error'} for the Knowledge folder.`;
		throw new HttpsError('failed-precondition', message);
	}
	const files: DriveFile[] = [];
	let complete = true;
	const queue: { id: string; path: string[]; shortcut?: boolean }[] = [{ id, path: [] }];
	const unshared: string[] = [];
	// A shortcut can point back up the tree: each folder is walked once.
	const seen = new Set([id]);
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
				if (f.mimeType !== FOLDER) files.push({ ...f, path: folder.path });
				else if (seen.has(f.id)) continue;
				else if (folder.path.length < MAX_DEPTH) {
					seen.add(f.id);
					queue.push({ id: f.id, path: [...folder.path, f.name], shortcut: !!t });
				} else complete = false;
			}
			pageToken = res.data.nextPageToken ?? '';
			if (files.length >= MAX_ENTRIES) {
				return {
					folderId: id,
					files: files.slice(0, MAX_ENTRIES),
					complete: false,
					unshared,
					folders: seen.size - 1
				};
			}
		} while (pageToken);
	}
	return { folderId: id, files, complete, unshared, folders: seen.size - 1 };
}

async function textOf(f: DriveFile): Promise<string> {
	const client = await drive();
	const url =
		f.mimeType === DOC
			? `https://www.googleapis.com/drive/v3/files/${f.id}/export?mimeType=text/plain`
			: `https://www.googleapis.com/drive/v3/files/${f.id}?alt=media&supportsAllDrives=true`;
	const res = await client.request<string>({ url, responseType: 'text' });
	return String(res.data ?? '')
		.replace(/^\uFEFF/, '')
		.replace(/\r\n/g, '\n')
		.trim();
}

/**
 * Import the Knowledge folder: each readable file becomes (or updates) the entry `drive-<id>`;
 * a file gone from the folder takes its entry with it. The text is re-read only when the file
 * changed. The team's choices on an entry (use, topics, expiry) survive every import; a new import
 * starts as `relevant`, since documents can be long. Never writes to Drive.
 */
export async function importFolder() {
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
	// Every entry (the list is settings-sized): the imported ones to update, and any entry from
	// before the card existed gets its defaults, so the Knowledge page's audience query finds it.
	const all = (await collection.get()).docs;
	const missing = all.filter((d) => !d.data().audience || !d.data().status);
	for (const d of missing)
		await d.ref.set(
			{
				audience: d.data().audience ?? 'internal',
				status: d.data().status ?? 'draft',
				type: d.data().type ?? 'other'
			},
			{ merge: true }
		);
	const existing = new Map(
		all.filter((d) => d.data().source === 'drive').map((d) => [d.id, d.data()])
	);
	// Knowledge holds MAX_ENTRIES in all: imported documents take what the Hub's own entries leave.
	const room = Math.max(0, MAX_ENTRIES - (all.length - existing.size));
	const readable = importable.slice(0, room);
	if (importable.length > room)
		skipped.push(
			`${importable.length - room} documents over the ${MAX_ENTRIES}-entry limit (not imported)`
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
			(prev.typeSet || prev.type === folderType)
		)
			continue;
		// A shortcut to a file not shared with the Hub can't be read: report it, import the rest.
		let text: string;
		try {
			text = await textOf(f);
		} catch {
			// Kept if it was imported before (it was taken off the removal list above).
			skipped.push(`${where(f)} (can't be read: not shared with the Hub)`);
			continue;
		}
		// Its type from its top subfolder, unless the team set one in the Hub.
		// Its type follows its folder (moved from Brand to Legal = a policy) unless a person set one.
		const type = prev?.typeSet && prev.type ? prev.type : folderType;
		const body = {
			label: f.name.slice(0, MAX_LABEL),
			type,
			description: text.slice(0, MAX_IMPORTED),
			truncated: text.length > MAX_IMPORTED,
			source: 'drive',
			url: f.webViewLink,
			driveModifiedTime: f.modifiedTime,
			updatedBy: 'Drive import',
			updatedAt: serverTimestamp()
		};
		if (prev) {
			// Its text or its type (folder) changed: a person approves it again (until then not "Always").
			const changed = prev.driveModifiedTime !== f.modifiedTime || prev.type !== type;
			await collection
				.doc(docId)
				.set(
					changed && prev.status === 'approved'
						? { ...body, status: 'draft', approvedBy: '', approvedOn: '', lastReviewed: '' }
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
	const whole = complete && importable.length <= room;
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

// ------------------------------------------------------------------ actions

export const actions = {
	/** Every entry, oldest first; the always-on block and the index of the relevant ones. */
	list: async (_p: any, auth: any) => {
		const entries = (await list()).filter(visibleTo(isAdmin(auth)));
		const today = todayIso();
		const folder = await folderId();
		return {
			entries: entries.map((e) => ({
				...e,
				rank: rankOf(e),
				expired: isExpired(e, today),
				reviewDue: reviewDue(e, today)
			})),
			active: formatKnowledge(entries),
			relevant: relevantIndex(entries),
			folder: { id: folder, url: `https://drive.google.com/drive/folders/${folder}` },
			uses: USES,
			types: TYPES,
			audiences: AUDIENCES,
			statuses: STATUSES,
			reviewEvery: REVIEW_EVERY
		};
	},

	/** The full text of chosen entries: by `ids`, or every entry with `topic`. */
	get: async (p: any, auth: any) => {
		const ids = Array.isArray(p?.ids) ? p.ids.map(String).slice(0, 50) : [];
		const topic = str(p?.topic, 'topic', false);
		if (!ids.length && !topic) throw new HttpsError('invalid-argument', 'Give ids or a topic.');
		return { text: pick((await list()).filter(visibleTo(isAdmin(auth))), ids, topic) };
	},

	/**
	 * Create (no id) or update an entry; returns its id. On an imported entry only how Claude uses
	 * it, its topics and expiry change: its title and text come from Drive.
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
		let card = cleanCard(entry, stored, auth, cleanUse(entry).use);
		// What makes an entry say something else (its text, title or type, which sets its rank) takes
		// a person's approval again, whoever edits it: an approved entry can't be rewritten in place.
		if (stored && stored.status === 'approved' && card.status === 'approved' && !entry.reviewed) {
			const changed =
				(!imported &&
					((entry.description ?? '') !== (stored.description ?? '') ||
						(entry.label ?? '') !== (stored.label ?? ''))) ||
				card.type !== (stored.type ?? 'other');
			if (changed)
				card = { ...card, status: 'draft', approvedBy: '', approvedOn: '', lastReviewed: '' };
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
		const body = { ...clean(entry), ...card, ...typeSet, source: 'hub', ...meta };
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
