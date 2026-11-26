import { createHash } from 'node:crypto';
import { HttpsError } from 'firebase-functions/v2/https';
import { db } from '../../firestore';
import { callVia } from '../call-context';
import { createLogger, serverTimestamp, str, Timestamp } from '../utils';
import * as knowledge from '../knowledge/index';
import * as tv from '../tv/index';
import { SKILL_IDS as TV_SKILL_IDS } from '../tv/config';
import {
	DRIVE_CONNECTION,
	GITHUB_CONNECTION,
	GITHUB_PATTERNS,
	LEVELS,
	MAX_BODY,
	MAX_DESCRIPTION,
	MAX_FILES,
	MAX_LINES,
	MAX_NAME,
	MAX_SKILLS,
	MIN_DESCRIPTION,
	SKILL_COLLECTION,
	SOURCES,
	STALE_DAYS,
	TV_SKILL_URL,
	type Source
} from './config';
import {
	auditSkill,
	describe,
	isSkillPath,
	linkIssues,
	recompute,
	relativeLinks,
	type Issue
} from './audit';
import * as gh from './github';

/**
 * Skills (docs/skills.md): one `skill/{source}-{id}` document per skill from FLF TV, the Hub,
 * GitHub and the Skills Drive folder, each with its audit. Read only on GitHub and Drive. The list
 * is settings-sized (MAX_SKILLS): read whole, with only the fields a list needs.
 */

const logger = createLogger('skills');
export const collection = db.collection(SKILL_COLLECTION);

/** What a list shows: everything but the body. */
const LIST_FIELDS = [
	'name',
	'description',
	'source',
	'location',
	'url',
	'updatedAt',
	'importedAt',
	'audit',
	'truncated',
	'updatedBy',
	'repo',
	'sha',
	'links',
	'driveModifiedTime',
	'tvKey'
];

export interface Row {
	id: string;
	name: string;
	description: string;
	source: Source;
	location: string;
	url: string;
	updatedAt: number | null;
	importedAt: number | null;
	audit: Issue[];
	truncated: boolean;
	updatedBy: string;
	repo?: string;
	sha?: string;
	links?: string[];
	driveModifiedTime?: string;
	tvKey?: string;
}

const millis = (t: unknown): number | null =>
	(t as { toMillis?: () => number } | null)?.toMillis?.() ?? null;
const dateOf = (ms: number | null) => (ms === null ? null : new Date(ms));
const nameKey = (name: string) => name.trim().toLowerCase();

function rowOf(d: FirebaseFirestore.DocumentSnapshot): Row {
	const x = d.data() ?? {};
	return {
		id: d.id,
		name: x.name ?? '',
		description: x.description ?? '',
		source: x.source,
		location: x.location ?? '',
		url: x.url ?? '',
		updatedAt: millis(x.updatedAt),
		importedAt: millis(x.importedAt),
		audit: Array.isArray(x.audit) ? x.audit : [],
		truncated: x.truncated === true,
		updatedBy: x.updatedBy ?? '',
		...(x.repo ? { repo: x.repo, sha: x.sha, links: x.links ?? [] } : {}),
		...(x.driveModifiedTime ? { driveModifiedTime: x.driveModifiedTime } : {}),
		...(x.tvKey ? { tvKey: x.tvKey } : {})
	};
}

/** A skill as the page and Claude see it: without the import's bookkeeping. */
function shown(s: Row) {
	return {
		id: s.id,
		name: s.name,
		description: s.description,
		source: s.source,
		location: s.location,
		url: s.url,
		updatedAt: s.updatedAt,
		importedAt: s.importedAt,
		audit: s.audit,
		truncated: s.truncated,
		updatedBy: s.updatedBy
	};
}

/** Every skill without its body. One read per skill. */
async function rows(): Promise<Row[]> {
	const snap = await collection
		.select(...LIST_FIELDS)
		.limit(MAX_SKILLS)
		.get();
	return snap.docs.map(rowOf);
}

const who = (auth: any) => {
	const name = auth?.token?.name || auth?.token?.email || 'System';
	return callVia() === 'claude' ? `${name} · via Claude` : name;
};

/** Writes in batches (Firestore takes 500 per batch). */
async function commit(writes: ((b: FirebaseFirestore.WriteBatch) => void)[]) {
	for (let i = 0; i < writes.length; i += 400) {
		const batch = db.batch();
		writes.slice(i, i + 400).forEach((w) => w(batch));
		await batch.commit();
	}
}

/**
 * The list-wide checks (same name, not updated in STALE_DAYS) for every skill in `list`; writes
 * only the skills whose audit changed.
 */
async function applyListChecks(list: Row[]): Promise<void> {
	const changed = recompute(
		list.map((r) => ({ ...r, updatedAt: dateOf(r.updatedAt) })),
		new Date()
	);
	await commit(
		[...changed].map(
			([id, audit]) =>
				(b) =>
					b.update(collection.doc(id), { audit })
		)
	);
}

/** The same checks for the skills named like these only (after one save or delete). */
async function checkNames(keys: string[]): Promise<void> {
	const list: Row[] = [];
	for (const key of new Set(keys.filter(Boolean)))
		list.push(...(await collection.where('nameKey', '==', key).limit(50).get()).docs.map(rowOf));
	await applyListChecks(list);
}

/** A file's skill fields, audited. `fallback` names it when it names itself nowhere. */
function build(
	text: string,
	fallback: string,
	updatedAt: Date | null,
	links?: { links: string[]; repoPaths: ReadonlySet<string> }
) {
	const d = describe(text);
	const name = (d.name || fallback).slice(0, MAX_NAME);
	return {
		name,
		nameKey: nameKey(name),
		description: d.description.slice(0, MAX_DESCRIPTION * 4),
		body: text.slice(0, MAX_BODY),
		truncated: text.length > MAX_BODY,
		audit: auditSkill({ ...d, updatedAt, ...(links ?? {}) })
	};
}

/** Run `fn` over `items`, `n` at a time. */
async function eachLimit<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(n, items.length) }, async () => {
			while (next < items.length) await fn(items[next++]);
		})
	);
}

async function settingsOf(id: string): Promise<Record<string, string>> {
	return ((await db.collection('connection').doc(id).get()).data()?.settings ?? {}) as Record<
		string,
		string
	>;
}

// ------------------------------------------------------------------ FLF TV

/**
 * FLF TV's two skills, mirrored as `tv-clipping` and `tv-brand` (read only here). Rewritten only
 * when the TV skill changed since the mirror (its version, or a reset). Returns the names (old and
 * new) of the skills it rewrote, for the same-name check.
 */
async function mirrorTv(stored: Map<string, Row>): Promise<string[]> {
	const touched: string[] = [];
	for (const id of TV_SKILL_IDS) {
		const s = await tv.skillOf(id);
		const tvKey = `${s.version}:${s.isDefault}`;
		const docId = `tv-${id}`;
		if (stored.get(docId)?.tvKey === tvKey) continue;
		const fallback = id === 'clipping' ? 'FLF TV clipping' : 'FLF TV brand';
		const fields = build(s.text, fallback, s.updatedAt ? new Date(s.updatedAt) : null);
		touched.push(nameKey(stored.get(docId)?.name ?? ''), fields.nameKey);
		await collection.doc(docId).set({
			...fields,
			source: 'tv',
			location: `FLF TV → Skill → ${id === 'clipping' ? 'Clipping' : 'Brand'}`,
			url: TV_SKILL_URL,
			updatedAt: s.updatedAt ? Timestamp.fromMillis(s.updatedAt) : null,
			updatedBy: s.updatedBy ?? 'Built in',
			importedAt: serverTimestamp(),
			tvKey
		});
	}
	return touched;
}

// ------------------------------------------------------------------ GitHub

/** Room left under MAX_SKILLS, and whether an import wrote anything (then the list is re-read). */
interface ImportState {
	left: number;
	wrote: boolean;
}

export interface SourceReport {
	/** False when the source isn't set up: nothing was read or removed. */
	configured: boolean;
	files: number;
	added: number;
	updated: number;
	removed: number;
	/** What wasn't read, and why nothing was removed when the read wasn't whole. */
	skipped: string[];
}

const empty = (configured: boolean, skipped: string[] = []): SourceReport => ({
	configured,
	files: 0,
	added: 0,
	updated: 0,
	removed: 0,
	skipped
});

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A skill file's name when it doesn't name itself: its folder for SKILL.md, else its file name. */
function fileName(path: string): string {
	const parts = path.split('/');
	const base = parts.at(-1) ?? path;
	if (/^skill\.md$/i.test(base) && parts.length > 1) return parts.at(-2)!;
	return base.replace(/\.(md|markdown|txt)$/i, '');
}

/** Stable doc id of a file in a repo (paths have slashes; ids can't). */
const githubId = (repo: string, path: string) =>
	`github-${createHash('sha1').update(`${repo}:${path}`).digest('hex').slice(0, 24)}`;

/**
 * Import the skill files of every listed repo (GITHUB_PATTERNS). A file is re-read only when its
 * sha changed; its relative links are re-checked against each new tree. A skill gone from a repo
 * read whole is removed; a repo not read whole (unreachable, listing cut, a file unreadable)
 * removes nothing.
 */
async function importGithub(
	token: string | undefined,
	stored: Map<string, Row>,
	state: ImportState
): Promise<SourceReport> {
	const { repos, invalid } = gh.parseRepos((await settingsOf(GITHUB_CONNECTION)).repos);
	if (!token || !repos.length)
		return empty(false, [
			!token
				? 'GitHub is not set up: the GITHUB_SKILLS_TOKEN secret is missing (Connections → Skills on GitHub).'
				: 'GitHub is not set up: no repos listed (Connections → Skills on GitHub).'
		]);
	const r = empty(
		true,
		invalid.map((l) => `"${l}" is not owner/repo: not read`)
	);
	const seen = new Set<string>();
	const whole = new Set<string>();
	for (const repo of repos) {
		try {
			const { defaultBranch } = await gh.repoInfo(repo, token);
			const { entries, truncated } = await gh.tree(repo, defaultBranch, token);
			const paths = new Set(entries.map((e) => e.path));
			let files = entries.filter((e) => e.type === 'blob' && isSkillPath(e.path));
			let complete = !truncated;
			if (truncated)
				r.skipped.push(`${repo}: GitHub cut its file list (too many files): nothing removed`);
			if (files.length > MAX_FILES) {
				r.skipped.push(`${repo}: over ${MAX_FILES} skill files, the rest not read`);
				files = files.slice(0, MAX_FILES);
				complete = false;
			}
			r.files += files.length;
			await eachLimit(files, 4, async (f) => {
				const id = githubId(repo, f.path);
				seen.add(id);
				const prev = stored.get(id);
				if (prev && prev.sha === f.sha) {
					// Unchanged, but a file it links to may have gone: re-check its links only.
					const audit = [
						...prev.audit.filter((i) => i.code !== 'link'),
						...linkIssues(prev.links ?? [], paths)
					];
					if (JSON.stringify(audit) !== JSON.stringify(prev.audit)) {
						await collection.doc(id).update({ audit });
						state.wrote = true;
					}
					return;
				}
				if (!prev && state.left <= 0) {
					r.skipped.push(`${repo}/${f.path}: over the ${MAX_SKILLS}-skill limit, not imported`);
					complete = false;
					return;
				}
				let text: string;
				let changedAt: Date | null;
				try {
					[text, changedAt] = await Promise.all([
						gh.fileText(repo, f.path, defaultBranch, token),
						gh.lastCommitAt(repo, f.path, defaultBranch, token)
					]);
				} catch (e) {
					r.skipped.push(`${repo}/${f.path}: can't be read (${errText(e)})`);
					complete = false;
					return;
				}
				const links = relativeLinks(describe(text).body, f.path);
				await collection.doc(id).set({
					...build(text, fileName(f.path), changedAt, { links, repoPaths: paths }),
					source: 'github',
					location: `${repo}/${f.path}`,
					url: gh.blobUrl(repo, defaultBranch, f.path),
					repo,
					path: f.path,
					sha: f.sha,
					links,
					updatedAt: changedAt ? Timestamp.fromDate(changedAt) : null,
					updatedBy: 'GitHub import',
					importedAt: serverTimestamp()
				});
				state.wrote = true;
				if (prev) r.updated++;
				else {
					r.added++;
					state.left--;
				}
			});
			if (complete) whole.add(repo);
		} catch (e) {
			const status = e instanceof gh.GithubError ? e.status : 0;
			r.skipped.push(
				status === 401 || status === 403 || status === 404
					? `${repo}: the token can't read it (GitHub answered ${status}): nothing removed`
					: `${repo}: ${errText(e)}: nothing removed`
			);
		}
	}
	// A repo taken off the list loses its skills only when every listed repo was read whole.
	const allWhole = !invalid.length && whole.size === repos.length;
	const gone = [...stored.values()].filter(
		(s) =>
			s.source === 'github' &&
			!seen.has(s.id) &&
			(whole.has(s.repo ?? '') || (allWhole && !repos.includes(s.repo ?? '')))
	);
	await commit(gone.map((s) => (b) => b.delete(collection.doc(s.id))));
	r.removed = gone.length;
	return r;
}

// ------------------------------------------------------------------ Drive

/**
 * Import the Skills Drive folder (subfolders and shortcuts, like the Knowledge folder): each
 * Markdown, text or Google Doc becomes `drive-<file id>`, re-read only when it changed. A file gone
 * from a whole listing is removed; a partial listing removes nothing.
 */
async function importDrive(stored: Map<string, Row>, state: ImportState) {
	const folderId = String((await settingsOf(DRIVE_CONNECTION)).folderId ?? '').trim();
	if (!folderId)
		return empty(false, ['Drive is not set up: no folder id (Connections → Skills folder).']);
	const r = empty(true);
	let listing: knowledge.FolderListing;
	try {
		listing = await knowledge.listDriveFolder(folderId, 'Skills folder', MAX_FILES);
	} catch (e) {
		r.skipped.push(`${errText(e)} Nothing removed.`);
		return r;
	}
	const where = (f: knowledge.DriveFile) => [...f.path, f.name].join(' / ');
	const readable = listing.files.filter((f) => knowledge.READABLE.includes(f.mimeType));
	r.files = readable.length;
	r.skipped.push(
		...listing.files
			.filter((f) => !knowledge.READABLE.includes(f.mimeType))
			.map((f) => `${where(f)} (not Markdown, text or a Google Doc)`),
		...listing.unshared.map(
			(p) =>
				`${p} (a shortcut to a folder not shared with 900685987021-compute@developer.gserviceaccount.com)`
		)
	);
	let complete = listing.complete;
	if (!complete)
		r.skipped.push(
			`The folder wasn't read whole (over ${MAX_FILES} files, too deep, or a shortcut the Hub can't open): nothing removed`
		);
	const seen = new Set<string>();
	await eachLimit(readable, 4, async (f) => {
		const id = `drive-${f.id}`;
		seen.add(id);
		const prev = stored.get(id);
		const location = `Skills folder / ${where(f)}`;
		if (prev && prev.driveModifiedTime === f.modifiedTime) {
			// Moved or renamed without a change to its text: only where it is.
			if (prev.location !== location) {
				await collection.doc(id).update({ location, url: f.webViewLink });
				state.wrote = true;
			}
			return;
		}
		if (!prev && state.left <= 0) {
			r.skipped.push(`${where(f)}: over the ${MAX_SKILLS}-skill limit, not imported`);
			complete = false;
			return;
		}
		let text: string;
		try {
			text = await knowledge.textOf(f);
		} catch {
			r.skipped.push(`${where(f)} (can't be read: not shared with the Hub)`);
			complete = false;
			return;
		}
		const changedAt = new Date(f.modifiedTime);
		await collection.doc(id).set({
			...build(text, fileName(f.name), changedAt),
			source: 'drive',
			location,
			url: f.webViewLink,
			driveModifiedTime: f.modifiedTime,
			updatedAt: Timestamp.fromDate(changedAt),
			updatedBy: 'Drive import',
			importedAt: serverTimestamp()
		});
		state.wrote = true;
		if (prev) r.updated++;
		else {
			r.added++;
			state.left--;
		}
	});
	if (complete) {
		const gone = [...stored.values()].filter((s) => s.source === 'drive' && !seen.has(s.id));
		await commit(gone.map((s) => (b) => b.delete(collection.doc(s.id))));
		r.removed = gone.length;
	}
	return r;
}

/**
 * Import every source now: FLF TV, GitHub, Drive; then the list-wide checks. Read only on GitHub
 * and Drive. Reads: the skill list once (no bodies), twice when something changed; per GitHub repo
 * one repo, one tree and two calls per changed file; per Drive folder one listing per folder and one
 * export per changed file.
 */
export async function sync(token: string | undefined) {
	const before = await rows();
	const stored = new Map(before.map((s) => [s.id, s]));
	const state: ImportState = { left: MAX_SKILLS - before.length, wrote: false };
	state.wrote = (await mirrorTv(stored)).length > 0;
	const github = await importGithub(token, stored, state);
	const drive = await importDrive(stored, state);
	// Removals happen in the imports too.
	if (github.removed || drive.removed) state.wrote = true;
	// Names and dates across the whole list, after the imports (re-read when one of them wrote).
	await applyListChecks(state.wrote ? await rows() : before);
	const at = serverTimestamp();
	await Promise.all(
		(
			[
				[GITHUB_CONNECTION, github],
				[DRIVE_CONNECTION, drive]
			] as const
		).map(([id, report]) =>
			db.collection('connection').doc(id).set({ lastSyncAt: at, lastSync: report }, { merge: true })
		)
	);
	const result = { tv: TV_SKILL_IDS.length, github, drive };
	logger.log(
		`sync ${JSON.stringify({
			github: { ...github, skipped: github.skipped.length },
			drive: { ...drive, skipped: drive.skipped.length }
		})}`
	);
	return result;
}

// ------------------------------------------------------------------ connection checks

export interface Check {
	status: 'ok' | 'error' | 'not_configured';
	detail: string;
	hint?: string;
}

/** Skills on GitHub: GET /repos/{repo} for each listed repo with the token. */
export async function checkGithub(token: string | undefined): Promise<Check> {
	const { repos, invalid } = gh.parseRepos((await settingsOf(GITHUB_CONNECTION)).repos);
	if (!token || !repos.length)
		return {
			status: 'not_configured',
			detail: !token ? 'The GITHUB_SKILLS_TOKEN secret is not set.' : 'No repos listed.',
			hint: 'Open it on Connections and follow “How to set it up”.'
		};
	const unreachable: string[] = [];
	for (const repo of repos) {
		try {
			await gh.repoInfo(repo, token);
		} catch (e) {
			unreachable.push(
				`${repo} (${e instanceof gh.GithubError && e.status ? e.status : 'no answer'})`
			);
		}
	}
	const bad = [...invalid.map((l) => `"${l}" (not owner/repo)`), ...unreachable];
	if (bad.length)
		return {
			status: 'error',
			detail: `Not reachable with the token: ${bad.join(', ')}. Reachable: ${repos.length - unreachable.length} of ${repos.length}.`,
			hint: 'Check each repo is written owner/repo and that the token has read access to “Contents” on it (a developer renews the token if it expired).'
		};
	return { status: 'ok', detail: `${repos.length} repos reachable: ${repos.join(', ')}.` };
}

/** Skills folder (Drive): list it as the import does. */
export async function checkDrive(): Promise<Check> {
	const folderId = String((await settingsOf(DRIVE_CONNECTION)).folderId ?? '').trim();
	if (!folderId)
		return {
			status: 'not_configured',
			detail: 'No folder id.',
			hint: 'Open it on Connections and follow “How to set it up”.'
		};
	const { files, folders, unshared } = await knowledge.listDriveFolder(
		folderId,
		'Skills folder',
		MAX_FILES
	);
	if (unshared.length)
		return {
			status: 'error',
			detail: `Shortcuts to folders the Hub can't open: ${unshared.join(', ')}.`,
			hint: 'Share those folders with 900685987021-compute@developer.gserviceaccount.com as Viewer.'
		};
	const readable = files.filter((f) => knowledge.READABLE.includes(f.mimeType)).length;
	return {
		status: 'ok',
		detail: `${files.length} files in ${folders + 1} folders, ${readable} importable (Markdown, text, Google Docs).`
	};
}

// ------------------------------------------------------------------ actions

export const actions = {
	/** Sources, audit levels, limits, and where each source is set up. */
	'config.get': async () => {
		const [githubDoc, driveDoc] = await Promise.all(
			[GITHUB_CONNECTION, DRIVE_CONNECTION].map((id) => db.collection('connection').doc(id).get())
		);
		const folderId = String(driveDoc.data()?.settings?.folderId ?? '').trim();
		const last = (d: FirebaseFirestore.DocumentSnapshot) =>
			d.data()?.lastSync ? { at: millis(d.data()?.lastSyncAt), ...d.data()?.lastSync } : null;
		return {
			sources: SOURCES,
			levels: LEVELS,
			patterns: GITHUB_PATTERNS,
			limits: {
				maxBody: MAX_BODY,
				maxName: MAX_NAME,
				maxDescription: MAX_DESCRIPTION,
				minDescription: MIN_DESCRIPTION,
				maxLines: MAX_LINES,
				staleDays: STALE_DAYS,
				maxSkills: MAX_SKILLS
			},
			repos: gh.parseRepos(githubDoc.data()?.settings?.repos).repos,
			folder: folderId
				? { id: folderId, url: `https://drive.google.com/drive/folders/${folderId}` }
				: null,
			lastSync: { github: last(githubDoc), drive: last(driveDoc) }
		};
	},

	/** Every skill with its audit, without bodies. FLF TV's are refreshed when they changed. */
	list: async () => {
		let list = await rows();
		const touched = await mirrorTv(new Map(list.map((s) => [s.id, s])));
		if (touched.length) {
			await checkNames(touched);
			list = await rows();
		}
		return { skills: list.map(shown), full: list.length >= MAX_SKILLS };
	},

	/** One skill with its body; `content` is the body without its front matter. */
	get: async (p: any) => {
		const id = str(p?.id, 'id');
		const doc = await collection.doc(id).get();
		if (!doc.exists) throw new HttpsError('not-found', 'Skill not found.');
		const body = String(doc.data()?.body ?? '');
		const row = shown(rowOf(doc));
		const d = row.source === 'hub' ? null : describe(body);
		return { ...row, body, content: d ? d.body : body, frontMatter: d?.frontMatter ?? {} };
	},

	/** Create (no id) or edit a skill written in the Hub. */
	save: async (p: any, auth: any) => {
		const id = str(p?.id, 'id', false);
		const name = str(p?.name, 'name');
		const description = str(p?.description, 'description', false);
		const body = typeof p?.body === 'string' ? p.body.replace(/\r\n/g, '\n').trim() : '';
		if (name.length > MAX_NAME)
			throw new HttpsError('invalid-argument', `Keep the name under ${MAX_NAME} characters.`);
		if (description.length > MAX_DESCRIPTION)
			throw new HttpsError(
				'invalid-argument',
				`Keep the description under ${MAX_DESCRIPTION.toLocaleString('en')} characters: Claude reads no more.`
			);
		if (body.length > MAX_BODY)
			throw new HttpsError(
				'invalid-argument',
				`The skill is too long (${MAX_BODY.toLocaleString('en')} characters at most).`
			);
		let prevKey = '';
		if (id) {
			const prev = (await collection.doc(id).get()).data();
			if (!prev) throw new HttpsError('not-found', 'Skill not found.');
			if (prev.source !== 'hub')
				throw new HttpsError(
					'failed-precondition',
					'Only skills written in the Hub are edited here: this one is edited where it comes from.'
				);
			prevKey = prev.nameKey ?? '';
		} else if ((await collection.count().get()).data().count >= MAX_SKILLS)
			throw new HttpsError(
				'resource-exhausted',
				`Skills is full (${MAX_SKILLS}). Delete skills you no longer use.`
			);
		const ref = id ? collection.doc(id) : collection.doc(`hub-${collection.doc().id}`);
		const fields = {
			name,
			nameKey: nameKey(name),
			description,
			body,
			truncated: false,
			audit: auditSkill({ name, description, frontMatterError: null, body, updatedAt: new Date() }),
			source: 'hub',
			location: 'Hub',
			url: '',
			updatedAt: serverTimestamp(),
			importedAt: serverTimestamp(),
			updatedBy: who(auth)
		};
		await ref.set(id ? fields : { ...fields, createdAt: serverTimestamp() }, { merge: true });
		await checkNames([prevKey, nameKey(name)]);
		logger.log(`${id ? 'updated' : 'created'} ${ref.id}`);
		return { id: ref.id };
	},

	/** Delete a skill written in the Hub (the others go when they leave their source). */
	delete: async (p: any) => {
		const id = str(p?.id, 'id');
		const prev = (await collection.doc(id).get()).data();
		if (!prev) throw new HttpsError('not-found', 'Skill not found.');
		if (prev.source !== 'hub')
			throw new HttpsError(
				'failed-precondition',
				'Only skills written in the Hub are deleted here: remove this one where it comes from.'
			);
		await collection.doc(id).delete();
		await checkNames([prev.nameKey ?? '']);
		logger.log(`deleted ${id}`);
		return { ok: true };
	}
};
