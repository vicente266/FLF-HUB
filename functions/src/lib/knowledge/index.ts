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
	USES,
	type Use
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
	/** How Claude uses it; missing = `always` (entries written before uses existed). */
	use?: Use;
	topics?: string[];
	/** `drive` when imported from the Knowledge folder; missing = written in the Hub. */
	source?: 'hub' | 'drive';
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

const useOf = (e: Knowledge): Use => e.use ?? 'always';

/**
 * One entry as its own `<entry label="…" topics="…" valid_until="…">` block, text verbatim inside,
 * so Claude always sees where an entry starts and ends and its own bullets never run into the next.
 */
function toEntry(entry: Knowledge): string {
	const attr = (s: string) => s.trim().replace(/"/g, "'");
	const label = entry.label ? attr(entry.label) : '';
	const topics = (entry.topics ?? []).map(attr).join(', ');
	const expiredAt = entry.expiredAt?.trim();
	// An entry's own text can't close its block or open another (or the knowledge frame).
	const description = (entry.description?.trim() ?? '').replace(
		/<(\/?)(entry|flf_knowledge)\b/gi,
		'‹$1$2'
	);
	if (!description) return label ? `<entry>\n${label}\n</entry>` : '';
	const attrs = [
		label && ` label="${label}"`,
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
		.map(toEntry)
		.filter(Boolean)
		.join('\n\n');
}

/** The `relevant` entries Claude can ask for: id, title and topics only. */
export function relevantIndex(entries: Entry[]) {
	const today = todayIso();
	return entries
		.filter((e) => useOf(e) === 'relevant' && !isExpired(e, today))
		.map((e) => ({ id: e.id, label: e.label || '(untitled)', topics: e.topics ?? [] }));
}

/** The full text of the chosen entries (by id, or every one with a topic), never `off` or expired. */
export function pick(entries: Entry[], ids: string[], topic: string): string {
	const today = todayIso();
	const t = topic.trim().toLowerCase();
	return formatKnowledge(
		entries
			.filter((e) => useOf(e) !== 'off' && !isExpired(e, today))
			.filter(
				(e) => ids.includes(e.id) || (t && (e.topics ?? []).some((x) => x.toLowerCase() === t))
			)
			.map((e) => ({ ...e, use: 'always' as const }))
	);
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
			use: (x.use as Use) ?? 'always',
			topics: x.topics ?? [],
			source: x.source === 'drive' ? 'drive' : 'hub',
			url: x.url ?? '',
			truncated: x.truncated === true,
			updatedBy: x.updatedBy ?? ''
		};
	});
}

/** The always-on block (empty string when none), read fresh so expiry is honoured. */
export async function activeText(): Promise<string> {
	return formatKnowledge(await list());
}

const who = (auth: any) => {
	const name = auth?.token?.name || auth?.token?.email || 'System';
	return callVia() === 'claude' ? `${name} · via Claude` : name;
};

function cleanUse(p: any): { use: Use; topics: string[] } {
	const use = (p?.use ?? 'always') as Use;
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
}

async function drive() {
	const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/drive.readonly'] });
	return auth.getClient();
}

async function folderId(): Promise<string> {
	const s = (await db.collection('connection').doc('knowledge-folder').get()).data()?.settings;
	return String(s?.folderId ?? '').trim() || DEFAULT_FOLDER_ID;
}

/** The folder's files (direct children, not trashed). Read only. */
export async function listFolder(): Promise<{ folderId: string; files: DriveFile[] }> {
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
		const status = (err as { response?: { status?: number } }).response?.status;
		throw new HttpsError(
			'failed-precondition',
			status === 404 || status === 403
				? "The Hub can't see the Knowledge folder: share it with 900685987021-compute@developer.gserviceaccount.com as Viewer."
				: `Drive answered ${status ?? 'with an error'} for the Knowledge folder.`
		);
	}
	const files: DriveFile[] = [];
	let pageToken = '';
	do {
		const params = new URLSearchParams({
			q: `'${id.replace(/'/g, '')}' in parents and trashed = false`,
			fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink)',
			pageSize: '200',
			supportsAllDrives: 'true',
			includeItemsFromAllDrives: 'true',
			...(pageToken ? { pageToken } : {})
		});
		const res = await client.request<{ files?: DriveFile[]; nextPageToken?: string }>({
			url: `https://www.googleapis.com/drive/v3/files?${params}`
		});
		files.push(...(res.data.files ?? []));
		pageToken = res.data.nextPageToken ?? '';
	} while (pageToken && files.length < MAX_ENTRIES);
	return { folderId: id, files };
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
	const { folderId: id, files } = await listFolder();
	const readable = files.filter((f) => READABLE.includes(f.mimeType));
	const skipped = files.filter((f) => !READABLE.includes(f.mimeType)).map((f) => f.name);
	const existing = new Map(
		(await collection.where('source', '==', 'drive').get()).docs.map((d) => [d.id, d.data()])
	);
	let added = 0;
	let updated = 0;
	for (const f of readable) {
		const docId = `${DRIVE_PREFIX}${f.id}`;
		const prev = existing.get(docId);
		existing.delete(docId);
		if (prev && prev.driveModifiedTime === f.modifiedTime && prev.label === f.name) continue;
		const text = await textOf(f);
		const body = {
			label: f.name.slice(0, MAX_LABEL),
			description: text.slice(0, MAX_IMPORTED),
			truncated: text.length > MAX_IMPORTED,
			source: 'drive',
			url: f.webViewLink,
			driveModifiedTime: f.modifiedTime,
			updatedBy: 'Drive import',
			updatedAt: serverTimestamp()
		};
		if (prev) {
			await collection.doc(docId).set(body, { merge: true });
			updated++;
		} else {
			await collection.doc(docId).set({
				...body,
				expiredAt: '',
				use: 'relevant',
				topics: [],
				createdAt: serverTimestamp()
			});
			added++;
		}
	}
	// What's left was deleted from (or moved out of) the folder.
	for (const docId of existing.keys()) await collection.doc(docId).delete();
	const removed = existing.size;
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
	list: async () => {
		const entries = await list();
		const today = todayIso();
		const folder = await folderId();
		return {
			entries: entries.map((e) => ({ ...e, expired: isExpired(e, today) })),
			active: formatKnowledge(entries),
			relevant: relevantIndex(entries),
			folder: { id: folder, url: `https://drive.google.com/drive/folders/${folder}` },
			uses: USES
		};
	},

	/** The full text of chosen entries: by `ids`, or every entry with `topic`. */
	get: async (p: any) => {
		const ids = Array.isArray(p?.ids) ? p.ids.map(String).slice(0, 50) : [];
		const topic = str(p?.topic, 'topic', false);
		if (!ids.length && !topic) throw new HttpsError('invalid-argument', 'Give ids or a topic.');
		return { text: pick(await list(), ids, topic) };
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
		if (ref) {
			// Editing: fields not sent keep their stored value (Claude may send only the one it changes).
			const stored = (await ref.get()).data();
			if (!stored) throw new HttpsError('not-found', 'Entry not found.');
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
		const meta = { updatedBy: who(auth), updatedAt: serverTimestamp() };
		if (ref && imported) {
			const expiredAt = str(entry.expiredAt, 'expiredAt', false);
			if (expiredAt && !/^\d{4}-\d{2}-\d{2}$/.test(expiredAt))
				throw new HttpsError('invalid-argument', 'Pick a valid expiry date.');
			// The import's own stamp stays: a Hub edit here is not a change in Drive.
			await ref.set({ ...cleanUse(entry), expiredAt, updatedAt: meta.updatedAt }, { merge: true });
			logger.log(`updated use of ${id}`);
			return { id };
		}
		const body = { ...clean(entry), source: 'hub', ...meta };
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
	delete: async (p: any) => {
		const id = str(p?.id, 'id');
		const ref = collection.doc(id);
		const stored = (await ref.get()).data();
		if (!stored) throw new HttpsError('not-found', 'Entry not found.');
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
