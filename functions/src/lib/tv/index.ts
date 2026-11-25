import { HttpsError } from 'firebase-functions/v2/https';
import { db } from '../../firestore';
import { serverTimestamp, str, oneOf } from '../utils';
import {
	CLIP_COLLECTION,
	CLIP_STATUSES,
	DEFAULT_BRAND,
	DEFAULT_BRAND_SKILL,
	DEFAULT_CLIPPING_SKILL,
	SKILL_COLLECTION,
	SKILL_IDS,
	STALE_MS,
	TRANSCRIPT_COLLECTION,
	VIDEO_COLLECTION,
	VIDEO_STATUSES,
	type Brand,
	type SkillId
} from './config';

export const videos = db.collection(VIDEO_COLLECTION);
export const clips = db.collection(CLIP_COLLECTION);
export const skills = db.collection(SKILL_COLLECTION);

/** A job the worker holds ('processing' / 'rendering') and still updates: hands off. */
const busy = (d: FirebaseFirestore.DocumentData | undefined, kind: keyof typeof STALE_MS) =>
	d?.status === (kind === 'video' ? 'processing' : 'rendering') &&
	Date.now() - (d.updatedAt?.toMillis?.() ?? Date.now()) < STALE_MS[kind];

const who = (auth: any) => auth?.token?.name || auth?.token?.email || 'Someone';

/** The Drive file id in a share link, or the id itself. */
export function driveIdOf(input: string): string {
	const s = input.trim();
	const m =
		/\/file\/d\/([A-Za-z0-9_-]{10,})/.exec(s) ??
		/[?&]id=([A-Za-z0-9_-]{10,})/.exec(s) ??
		/^([A-Za-z0-9_-]{20,})$/.exec(s);
	if (!m) throw new HttpsError('invalid-argument', 'Paste a Google Drive file link.');
	return m[1];
}

const DEFAULT_TEXT: Record<SkillId, string> = {
	clipping: DEFAULT_CLIPPING_SKILL,
	brand: DEFAULT_BRAND_SKILL
};

/** A skill as saved, or its default. */
export async function skillOf(id: SkillId) {
	const d = (await skills.doc(id).get()).data();
	return {
		id,
		text: (d?.text as string) || DEFAULT_TEXT[id],
		brand: id === 'brand' ? { ...DEFAULT_BRAND, ...(d?.brand ?? {}) } : undefined,
		version: (d?.version as number) ?? 0,
		updatedBy: (d?.updatedBy as string) ?? null,
		updatedAt: d?.updatedAt?.toMillis?.() ?? null,
		isDefault: !d?.text
	};
}

/** Only known brand keys, each with its default's type. */
function cleanBrand(input: unknown): Partial<Brand> {
	const raw = (input ?? {}) as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [k, def] of Object.entries(DEFAULT_BRAND)) {
		const v = raw[k];
		if (v === undefined) continue;
		if (typeof def === 'number') {
			const n = Number(v);
			if (!Number.isFinite(n) || n < 0 || n > 4000)
				throw new HttpsError('invalid-argument', `Invalid ${k}.`);
			out[k] = n;
		} else if (typeof def === 'boolean') out[k] = v === true;
		else {
			const s = String(v).trim().slice(0, 200);
			if (k.endsWith('Color') && !/^#[0-9A-Fa-f]{6}$/.test(s)) {
				throw new HttpsError('invalid-argument', `${k} must be a colour like #0F1E2E.`);
			}
			out[k] = s;
		}
	}
	const b = { ...DEFAULT_BRAND, ...out } as Brand;
	if (b.minSeconds < 5 || b.maxSeconds > 180 || b.minSeconds >= b.maxSeconds) {
		throw new HttpsError('invalid-argument', 'Clip length: 5 ≤ min < max ≤ 180 seconds.');
	}
	if (b.maxClips < 1 || b.maxClips > 12)
		throw new HttpsError('invalid-argument', 'Clips per video: 1 to 12.');
	return out as Partial<Brand>;
}

/** Fields a person may change on a clip, validated against its video's length. */
async function clipEdits(p: any, clip: FirebaseFirestore.DocumentData) {
	const out: Record<string, unknown> = {};
	for (const k of ['hook', 'title', 'caption'] as const) {
		if (p[k] !== undefined) out[k] = str(p[k], k, false).slice(0, k === 'caption' ? 2200 : 120);
	}
	if (Array.isArray(p.hashtags)) {
		out.hashtags = p.hashtags
			.map((h: unknown) => String(h).trim().replace(/^#?/, '#'))
			.filter((h: string) => h.length > 1)
			.slice(0, 10);
	}
	if (p.focusX !== undefined) {
		const f = Number(p.focusX);
		if (!(f >= 0 && f <= 1)) throw new HttpsError('invalid-argument', 'Focus is between 0 and 1.');
		out.focusX = f;
	}
	if (p.start !== undefined || p.end !== undefined) {
		const start = Number(p.start ?? clip.start);
		const end = Number(p.end ?? clip.end);
		const video = (await videos.doc(clip.videoId).get()).data();
		const max = Number(video?.durationSec ?? Infinity);
		if (!(start >= 0 && end > start + 3 && end <= max + 0.5)) {
			throw new HttpsError(
				'invalid-argument',
				'Start and end must be inside the video, at least 3 s apart.'
			);
		}
		out.start = Math.round(start * 100) / 100;
		out.end = Math.round(end * 100) / 100;
	}
	return out;
}

export const actions = {
	'config.get': async () => ({
		videoStatuses: VIDEO_STATUSES,
		clipStatuses: CLIP_STATUSES,
		skills: SKILL_IDS,
		defaultBrand: DEFAULT_BRAND,
		// Past this, a job the Mac holds counts as abandoned: Run again and Delete are allowed.
		staleMs: STALE_MS
	}),

	'video.add': async (p: any, auth: any) => {
		const driveFileId = driveIdOf(str(p.url, 'url'));
		const dup = await videos.where('driveFileId', '==', driveFileId).limit(1).get();
		if (!dup.empty) throw new HttpsError('already-exists', 'That video is already in FLF TV.');
		const ref = await videos.add({
			title: str(p.title, 'title', false) || 'Untitled video',
			driveFileId,
			driveUrl: `https://drive.google.com/file/d/${driveFileId}/view`,
			status: 'queued',
			step: null,
			error: null,
			durationSec: null,
			clipCount: 0,
			createdBy: who(auth),
			createdByUid: auth.uid,
			createdAt: serverTimestamp(),
			updatedAt: serverTimestamp()
		});
		return { id: ref.id };
	},

	/**
	 * Back to the queue: transcribed again and new clips proposed (old suggestions are removed).
	 * Refused while it is processing, unless the worker abandoned it (STALE_MS).
	 */
	'video.retry': async (p: any) => {
		const id = str(p.id, 'id');
		const ref = videos.doc(id);
		await db.runTransaction(async (tx) => {
			const [snap, old] = await Promise.all([
				tx.get(ref),
				tx.get(clips.where('videoId', '==', id).where('status', '==', 'suggested'))
			]);
			const v = snap.data();
			if (!v) throw new HttpsError('not-found', 'Video not found.');
			if (busy(v, 'video'))
				throw new HttpsError('failed-precondition', 'It is being processed now.');
			old.forEach((c) => tx.delete(c.ref));
			tx.update(ref, { status: 'queued', step: null, error: null, updatedAt: serverTimestamp() });
		});
		return { ok: true };
	},

	/**
	 * Refused while the Mac works on it or on one of its clips (in a transaction with its claims),
	 * unless the worker abandoned that job (STALE_MS).
	 */
	'video.delete': async (p: any) => {
		const id = str(p.id, 'id');
		await db.runTransaction(async (tx) => {
			const [v, all] = await Promise.all([
				tx.get(videos.doc(id)),
				tx.get(clips.where('videoId', '==', id))
			]);
			if (busy(v.data(), 'video'))
				throw new HttpsError('failed-precondition', 'It is being processed now.');
			if (all.docs.some((c) => busy(c.data(), 'clip'))) {
				throw new HttpsError(
					'failed-precondition',
					'One of its clips is rendering now. Delete it once that is done.'
				);
			}
			all.forEach((c) => tx.delete(c.ref));
			tx.delete(videos.doc(id));
			tx.delete(db.collection(TRANSCRIPT_COLLECTION).doc(id));
		});
		return { ok: true };
	},

	/**
	 * Edit a clip. Editing a rendered clip sends it back to be rendered again. Refused while it
	 * renders, unless the worker abandoned it (STALE_MS); the check and the write share a
	 * transaction, so the worker can't claim the clip in between.
	 */
	'clip.update': async (p: any, auth: any) => {
		const ref = clips.doc(str(p.id, 'id'));
		await db.runTransaction(async (tx) => {
			const clip = (await tx.get(ref)).data();
			if (!clip) throw new HttpsError('not-found', 'Clip not found.');
			if (busy(clip, 'clip')) throw new HttpsError('failed-precondition', 'It is rendering now.');
			const edits = await clipEdits(p, clip);
			// Only a real change to what is on screen renders it again (the screen sends every field).
			const visual = ['start', 'end', 'hook', 'focusX'].some(
				(k) =>
					k in edits &&
					(typeof edits[k] === 'number' && typeof clip[k] === 'number'
						? Math.abs((edits[k] as number) - clip[k]) > 0.005
						: edits[k] !== clip[k])
			);
			tx.update(ref, {
				...edits,
				...(visual && clip.status === 'rendered' ? { status: 'approved', renderUrl: null } : {}),
				updatedBy: who(auth),
				updatedAt: serverTimestamp()
			});
		});
		return { ok: true };
	},

	/** approve (the worker renders it), reject, or back to suggested; same check as clip.update. */
	'clip.status': async (p: any, auth: any) => {
		const ref = clips.doc(str(p.id, 'id'));
		const status = oneOf(p.status, ['approved', 'rejected', 'suggested'] as const, 'status');
		await db.runTransaction(async (tx) => {
			const clip = (await tx.get(ref)).data();
			if (!clip) throw new HttpsError('not-found', 'Clip not found.');
			if (busy(clip, 'clip')) throw new HttpsError('failed-precondition', 'It is rendering now.');
			tx.update(ref, { status, error: null, updatedBy: who(auth), updatedAt: serverTimestamp() });
		});
		return { ok: true };
	},

	'skill.get': async (p: any) => skillOf(oneOf(p.id, SKILL_IDS, 'skill')),

	/** Save a skill (and, for Brand, its renderer settings). The next video uses it. */
	'skill.save': async (p: any, auth: any) => {
		const id = oneOf(p.id, SKILL_IDS, 'skill');
		const text = str(p.text, 'text');
		if (text.length > 20000)
			throw new HttpsError(
				'invalid-argument',
				'The skill is too long (20,000 characters at most).'
			);
		const ref = skills.doc(id);
		await db.runTransaction(async (tx) => {
			const cur = (await tx.get(ref)).data();
			tx.set(ref, {
				text,
				...(id === 'brand' ? { brand: cleanBrand(p.brand) } : {}),
				version: ((cur?.version as number) ?? 0) + 1,
				updatedBy: who(auth),
				updatedAt: serverTimestamp()
			});
		});
		return skillOf(id);
	},

	'skill.reset': async (p: any) => {
		const id = oneOf(p.id, SKILL_IDS, 'skill');
		await skills.doc(id).delete();
		return skillOf(id);
	}
};
