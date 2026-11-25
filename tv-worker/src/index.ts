/**
 * FLF TV worker (README.md). Loops: takes the oldest queued video (download → transcribe →
 * Claude proposes clips → review in the Hub), then any approved clip (render → Drive). Run it on
 * the Mac with `npm start`; `npm run once` stops when there is nothing left to do.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { db, now, videos, clips, transcripts, skills } from './firestore.js';
import { download, fileInfo, upload } from './drive.js';
import { extractAudio, probe, transcribe } from './transcribe.js';
import { proposeClips } from './clipping.js';
import { detectSilences, gapsFromWords } from './silences.js';
import { renderClip } from './render.js';
import { makeCovers } from './cover.js';
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
		await download(driveFileId, path);
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

/** Claim one document in a transaction so two workers never take the same one. */
async function claim(q: FirebaseFirestore.Query, from: string, to: Record<string, unknown>) {
	return db.runTransaction(async (tx) => {
		const snap = await tx.get(q.limit(1));
		const doc = snap.docs[0];
		if (!doc || doc.data().status !== from) return null;
		tx.update(doc.ref, { ...to, workerId: config.workerId, updatedAt: now() });
		return doc;
	});
}

/** The oldest queued video → transcript and clip suggestions. */
async function processVideo(): Promise<boolean> {
	const doc = await claim(videos.where('status', '==', 'queued').orderBy('createdAt'), 'queued', {
		status: 'processing',
		step: 'downloading',
		error: null
	});
	if (!doc) return false;
	const v = doc.data();
	const step = (s: string, extra: Record<string, unknown> = {}) =>
		doc.ref.update({ step: s, ...extra, updatedAt: now() });
	log(`video ${doc.id} “${v.title}”`);
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
		await doc.ref.update({ status: 'failed', step: null, error: errText(e), updatedAt: now() });
	}
	return true;
}

/** One approved clip → rendered MP4 → Drive. */
async function renderOne(): Promise<boolean> {
	const doc = await claim(
		clips.where('status', '==', 'approved').orderBy('updatedAt'),
		'approved',
		{
			status: 'rendering',
			error: null
		}
	);
	if (!doc) return false;
	const c = doc.data();
	log(`render clip ${doc.id} “${c.hook}”`);
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
			endAssPath: join(dir, 'endcard.ass'),
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
		await doc.ref.update({ status: 'rendered', ...result, renderedAt: now(), updatedAt: now() });
		log(`clip ${doc.id} rendered`);
	} catch (e) {
		log(`clip ${doc.id} failed: ${errText(e)}`);
		await doc.ref.update({ status: 'failed', error: errText(e), updatedAt: now() });
	}
	return true;
}

/** Source videos untouched for a week are removed (they can be downloaded again). */
function cleanWorkDir(days = 7) {
	if (!existsSync(config.workDir)) return;
	const cutoff = Date.now() - days * 86_400_000;
	for (const d of readdirSync(config.workDir)) {
		const p = join(config.workDir, d);
		if (statSync(p).mtimeMs < cutoff) rmSync(p, { recursive: true, force: true });
	}
}

let stopping = false;
process.on('SIGINT', () => {
	if (stopping) process.exit(1);
	stopping = true;
	log('stopping after the current job (Ctrl+C again to quit now)');
});

const once = process.argv.includes('--once');
mkdirSync(config.workDir, { recursive: true });
cleanWorkDir();
log(`FLF TV worker ${config.workerId} on project ${config.projectId}${once ? ' (once)' : ''}`);
while (!stopping) {
	const did = (await processVideo()) || (await renderOne());
	if (did) continue;
	if (once) break;
	await new Promise((r) => setTimeout(r, config.pollSeconds * 1000));
}
log('done');
process.exit(0);
