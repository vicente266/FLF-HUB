/**
 * FLF TV worker (README.md). Loops: takes the oldest queued video (download → transcribe →
 * Claude proposes clips → review in the Hub), then any approved clip (render → Drive). Run it on
 * the Mac with `npm start`; `npm run once` stops when there is nothing left to do.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Timestamp } from 'firebase-admin/firestore';
import { config } from './config.js';
import { db, now, videos, clips, transcripts, skills } from './firestore.js';
import { download, fileInfo, upload } from './drive.js';
import { extractAudio, probe, transcribe } from './transcribe.js';
import { proposeClips } from './clipping.js';
import { detectSilences, gapsFromWords } from './silences.js';
import { renderClip } from './render.js';
import { makeCovers } from './cover.js';
import {
	HEARTBEAT_MS,
	MAX_ATTEMPTS,
	STALE_CHECK_MS,
	STALE_MS,
	isRenderOutput,
	recoverDecision
} from './jobs.js';
import {
	DEFAULT_BRAND,
	DEFAULT_BRAND_SKILL,
	DEFAULT_CLIPPING_SKILL
} from '../../functions/src/lib/tv/config.js';
import type { Brand, Word } from './types.js';

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/** The skills as saved in FLF TV (Clipping and Brand), else the built-in ones. */
async function loadSkills() {
	const [c, b] = await Promise.all([skills.doc('clipping').get(), skills.doc('brand').get()]);
	return {
		clipping: (c.data()?.text as string) || DEFAULT_CLIPPING_SKILL,
		clippingVersion: (c.data()?.version as number) ?? 0,
		brandSkill: (b.data()?.text as string) || DEFAULT_BRAND_SKILL,
		brand: { ...DEFAULT_BRAND, ...(b.data()?.brand ?? {}) } as Brand
	};
}

const dirOf = (videoId: string) => {
	const d = join(config.workDir, videoId);
	mkdirSync(d, { recursive: true });
	return d;
};

/** The source video on disk, downloaded from Drive when it isn't there yet. */
async function sourceOf(videoId: string, driveFileId: string): Promise<string> {
	if (config.localSource) return config.localSource;
	const path = join(dirOf(videoId), 'source');
	if (!existsSync(path) || statSync(path).size === 0) {
		const info = await fileInfo(driveFileId);
		if (!info.mimeType.startsWith('video/'))
			throw new Error(`The Drive file is not a video (${info.mimeType}).`);
		log(`downloading ${info.name} (${Math.round(Number(info.size ?? 0) / 1e6)} MB)`);
		// Into a .part file first, so a cut download is never taken for the whole video.
		await download(driveFileId, `${path}.part`);
		renameSync(`${path}.part`, path);
	}
	return path;
}

/** Firestore holds no nested arrays: the words are stored as three parallel arrays. */
const packWords = (words: Word[]) => ({
	w: words.map((x) => x.w),
	s: words.map((x) => x.s),
	e: words.map((x) => x.e)
});
const unpackWords = (d: FirebaseFirestore.DocumentData | undefined): Word[] =>
	(d?.w as string[] | undefined)?.map((w, i) => ({ w, s: d!.s[i], e: d!.e[i] })) ?? [];

type Ref = FirebaseFirestore.DocumentReference;
type Doc = FirebaseFirestore.QueryDocumentSnapshot;

/** Firestore's NOT_FOUND: the document was deleted while the worker held it. */
const notFound = (e: unknown) => (e as { code?: unknown })?.code === 5;

/** Update a job; a job deleted meanwhile is logged and skipped instead of stopping the worker. */
async function save(ref: Ref, data: Record<string, unknown>): Promise<boolean> {
	try {
		await ref.update(data);
		return true;
	} catch (e) {
		if (!notFound(e)) throw e;
		log(`${ref.path} was deleted meanwhile; moving on`);
		return false;
	}
}

/** Bump `updatedAt` every few minutes while a long step runs, so a live job never looks abandoned. */
function keepAlive(ref: Ref): () => void {
	const timer = setInterval(
		() =>
			void save(ref, { updatedAt: now() }).catch((e) => log(`heartbeat ${ref.id}: ${errText(e)}`)),
		HEARTBEAT_MS
	);
	return () => clearInterval(timer);
}

const lastStaleCheck: Record<string, number> = {};

/**
 * Claim one job in a transaction so two workers never take the same one: the next `fresh` one,
 * else (every STALE_CHECK_MS) one a stopped worker left `running` for longer than STALE_MS. An
 * abandoned job is retried until MAX_ATTEMPTS, then marked failed with `gaveUp`. Returns the
 * claimed doc, 'gave-up' when it only marked one failed, or null when there was nothing to do.
 */
async function claim(opts: {
	kind: keyof typeof STALE_MS;
	fresh: FirebaseFirestore.Query;
	running: string;
	to: Record<string, unknown>;
	gaveUp: Record<string, unknown>;
	collection: FirebaseFirestore.CollectionReference;
}): Promise<Doc | 'gave-up' | null> {
	const checkStale = Date.now() - (lastStaleCheck[opts.kind] ?? 0) >= STALE_CHECK_MS;
	const result = await db.runTransaction(async (tx) => {
		const fresh = (await tx.get(opts.fresh.limit(1))).docs[0];
		if (fresh) {
			tx.update(fresh.ref, {
				...opts.to,
				attempts: 1,
				workerId: config.workerId,
				updatedAt: now()
			});
			return fresh;
		}
		if (!checkStale) return null;
		const cutoff = Timestamp.fromMillis(Date.now() - STALE_MS[opts.kind]);
		const stale = (
			await tx.get(
				opts.collection
					.where('status', '==', opts.running)
					.where('updatedAt', '<', cutoff)
					.orderBy('updatedAt')
					.limit(1)
			)
		).docs[0];
		if (!stale) return 'none' as const;
		const attempts = stale.data().attempts as number | undefined;
		if (recoverDecision(attempts) === 'fail') {
			tx.update(stale.ref, { ...opts.gaveUp, updatedAt: now() });
			log(`${stale.ref.path} abandoned ${MAX_ATTEMPTS} times; marked failed`);
			return 'gave-up' as const;
		}
		tx.update(stale.ref, {
			...opts.to,
			attempts: (attempts ?? 1) + 1,
			recoveredAt: now(),
			workerId: config.workerId,
			updatedAt: now()
		});
		log(
			`${stale.ref.path} was abandoned by ${stale.data().workerId ?? 'a worker'}; taking it again`
		);
		return stale;
	});
	// Only an empty look counts: after a recovery there may be more to recover.
	if (result === 'none') lastStaleCheck[opts.kind] = Date.now();
	return result === 'none' ? null : result;
}

const GAVE_UP = `stopped ${MAX_ATTEMPTS} times without finishing (the Mac slept, restarted or the worker was stopped)`;

/** The oldest queued video → transcript and clip suggestions. */
async function processVideo(): Promise<boolean> {
	const doc = await claim({
		kind: 'video',
		fresh: videos.where('status', '==', 'queued').orderBy('createdAt'),
		collection: videos,
		running: 'processing',
		to: { status: 'processing', step: 'downloading', error: null },
		gaveUp: { status: 'failed', step: null, error: `Processing ${GAVE_UP}. Retry to start again.` }
	});
	if (doc === 'gave-up') return true;
	if (!doc) return false;
	const v = doc.data();
	const step = (s: string, extra: Record<string, unknown> = {}) =>
		save(doc.ref, { step: s, ...extra, updatedAt: now() });
	log(`video ${doc.id} “${v.title}”`);
	const stopKeepAlive = keepAlive(doc.ref);
	try {
		const source = await sourceOf(doc.id, v.driveFileId);
		const meta = await probe(source);
		await step('transcribing', {
			durationSec: Math.round(meta.duration * 10) / 10,
			width: meta.width,
			height: meta.height
		});
		const wav = join(dirOf(doc.id), 'audio.wav');
		await extractAudio(source, wav);
		const { words, laughs } = await transcribe(wav, join(dirOf(doc.id), 'transcript'));
		if (!words.length) throw new Error('No speech found in the video.');
		// The pauses, measured on the audio: where clips can be cut cleanly.
		await step('pauses');
		let silences = await detectSilences(wav);
		if (silences.length < 3) silences = gapsFromWords(words);
		await transcripts.doc(doc.id).set({
			...packWords(words),
			ss: silences.map((p) => p.s),
			se: silences.map((p) => p.e),
			l: laughs,
			createdAt: now()
		});
		await step('topics');
		const s = await loadSkills();
		const { clips: proposals, topics } = await proposeClips(
			s.clipping,
			s.brand,
			{ title: v.title, duration: meta.duration },
			words,
			silences
		);
		const batch = db.batch();
		proposals.forEach((c, index) =>
			batch.set(clips.doc(), {
				...c,
				videoId: doc.id,
				videoTitle: v.title,
				index,
				focusX: 0.5,
				// Rendered straight away unless the Brand settings ask for an Approve first.
				status: s.brand.autoRender ? 'approved' : 'suggested',
				skillVersion: s.clippingVersion,
				renderUrl: null,
				error: null,
				createdAt: now(),
				updatedAt: now()
			})
		);
		batch.update(doc.ref, {
			status: 'review',
			step: null,
			clipCount: proposals.length,
			topics,
			updatedAt: now()
		});
		await batch.commit();
		rmSync(wav, { force: true });
		log(`video ${doc.id}: ${proposals.length} clips to review`);
	} catch (e) {
		log(`video ${doc.id} failed: ${errText(e)}`);
		await save(doc.ref, { status: 'failed', step: null, error: errText(e), updatedAt: now() });
	} finally {
		stopKeepAlive();
	}
	await releaseVideo(doc.id);
	return true;
}

/** One approved clip → rendered MP4 → Drive. */
async function renderOne(): Promise<boolean> {
	const doc = await claim({
		kind: 'clip',
		fresh: clips.where('status', '==', 'approved').orderBy('updatedAt'),
		collection: clips,
		running: 'rendering',
		to: { status: 'rendering', error: null },
		gaveUp: { status: 'failed', error: `Rendering ${GAVE_UP}. Approve it again to retry.` }
	});
	if (doc === 'gave-up') return true;
	if (!doc) return false;
	const c = doc.data();
	log(`render clip ${doc.id} “${c.hook}”`);
	const stopKeepAlive = keepAlive(doc.ref);
	try {
		const video = (await videos.doc(c.videoId).get()).data();
		if (!video) throw new Error('Its video was deleted.');
		const tdoc = (await transcripts.doc(c.videoId).get()).data();
		const words = unpackWords(tdoc);
		const laughs = (tdoc?.l as number[] | undefined) ?? [];
		const source = await sourceOf(c.videoId, video.driveFileId);
		const meta = video.width ? { width: video.width, height: video.height } : await probe(source);
		const { brand, brandSkill } = await loadSkills();
		const dir = dirOf(c.videoId);
		const out = join(dir, `clip-${doc.id}.mp4`);
		await renderClip({
			source,
			width: meta.width,
			height: meta.height,
			clip: { start: c.start, end: c.end, hook: c.hook, focusX: c.focusX },
			words,
			brand,
			assPath: join(dir, `clip-${doc.id}.ass`),
			endAssPath: join(dir, `endcard-${doc.id}.ass`),
			out
		});
		// Cover and thumbnail on the best frame (people laughing or happy), with the hook and title.
		const covers = await makeCovers({
			source,
			width: meta.width,
			height: meta.height,
			clip: { start: c.start, end: c.end, hook: c.hook, focusX: c.focusX },
			videoTitle: video.title,
			laughs,
			brand,
			brandSkill,
			dir,
			id: doc.id
		});
		let result: Record<string, unknown> = {
			localPath: out,
			coverLocal: covers.cover,
			thumbnailLocal: covers.thumbnail,
			coverFrameTime: covers.frameTime,
			coverWhy: covers.why
		};
		if (brand.outputFolderId && !config.noUpload) {
			const base = `${video.title} – ${c.title || c.hook}`
				.replace(/[\\/:*?"<>|]/g, ' ')
				.slice(0, 110);
			const [f, cv, th] = [
				await upload(out, brand.outputFolderId, `${base}.mp4`),
				await upload(covers.cover, brand.outputFolderId, `${base} – cover.jpg`, 'image/jpeg'),
				await upload(
					covers.thumbnail,
					brand.outputFolderId,
					`${base} – thumbnail.jpg`,
					'image/jpeg'
				)
			];
			result = {
				renderUrl: f.webViewLink,
				renderFileId: f.id,
				coverUrl: cv.webViewLink,
				thumbnailUrl: th.webViewLink,
				coverFrameTime: covers.frameTime,
				coverWhy: covers.why,
				localPath: null,
				coverLocal: null,
				thumbnailLocal: null
			};
			for (const p of [out, covers.cover, covers.thumbnail]) rmSync(p, { force: true });
		}
		const saved = await save(doc.ref, {
			status: 'rendered',
			...result,
			renderedAt: now(),
			updatedAt: now()
		});
		if (saved) log(`clip ${doc.id} rendered`);
	} catch (e) {
		log(`clip ${doc.id} failed: ${errText(e)}`);
		await save(doc.ref, { status: 'failed', error: errText(e), updatedAt: now() });
	} finally {
		stopKeepAlive();
	}
	await releaseVideo(c.videoId);
	return true;
}

/**
 * Once no clip of a video may still be rendered ('suggested', 'approved' or 'rendering'), its
 * source and temp files go (they can be downloaded again; the 7-day sweep removes them anyway). Finished renders stay: without a Drive folder a clip's
 * `localPath` points at them, and the 7-day sweep removes them. One billed read.
 */
async function releaseVideo(videoId: string) {
	const dir = join(config.workDir, videoId);
	if (!existsSync(dir)) return;
	const busy = await clips
		.where('videoId', '==', videoId)
		.where('status', 'in', ['suggested', 'approved', 'rendering'])
		.limit(1)
		.get();
	if (!busy.empty) return;
	for (const f of readdirSync(dir)) {
		if (!isRenderOutput(f)) rmSync(join(dir, f), { recursive: true, force: true });
	}
}

/**
 * The work folder's housekeeping, run at start and hourly: files untouched for `days` (renders
 * included) and empty folders are removed, then every remaining video folder is released.
 */
async function cleanWorkDir(days = 7) {
	if (!existsSync(config.workDir)) return;
	const cutoff = Date.now() - days * 86_400_000;
	for (const d of readdirSync(config.workDir)) {
		const dir = join(config.workDir, d);
		if (!statSync(dir).isDirectory()) continue;
		for (const f of readdirSync(dir)) {
			const p = join(dir, f);
			if (statSync(p).mtimeMs < cutoff) rmSync(p, { recursive: true, force: true });
		}
		if (!readdirSync(dir).length) rmSync(dir, { recursive: true, force: true });
		else if (readdirSync(dir).some((f) => !isRenderOutput(f))) await releaseVideo(d);
	}
}

const CLEAN_EVERY_MS = 3_600_000;

let stopping = false;
process.on('SIGINT', () => {
	if (stopping) process.exit(1);
	stopping = true;
	log('stopping after the current job (Ctrl+C again to quit now)');
});

const once = process.argv.includes('--once');
mkdirSync(config.workDir, { recursive: true });
log(`FLF TV worker ${config.workerId} on project ${config.projectId}${once ? ' (once)' : ''}`);
let lastClean = 0;
while (!stopping) {
	let wait = config.pollSeconds;
	try {
		if (Date.now() - lastClean >= CLEAN_EVERY_MS) {
			await cleanWorkDir();
			lastClean = Date.now();
		}
		const did = (await processVideo()) || (await renderOne());
		if (did) continue;
		if (once) break;
	} catch (e) {
		// A Firestore or network blip: the job it hit is recovered later as abandoned.
		log(`error: ${errText(e)}; trying again in 60 s`);
		wait = 60;
	}
	await new Promise((r) => setTimeout(r, wait * 1000));
}
log('done');
process.exit(0);
