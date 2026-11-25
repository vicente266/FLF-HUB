/** Checks of the pure parts (no network, no Firestore): `npm test`. */
import assert from 'node:assert/strict';
import { validate, parseJson, pickStart, pickEnd } from './clipping.js';
import { parseSilences, cutStart, cutEnd } from './silences.js';
import { candidateTimes, coverAss } from './cover.js';
import { buildAss, cropFor, assColor } from './render.js';
import { toLines } from './transcribe.js';
import { DEFAULT_BRAND } from '../../functions/src/lib/tv/config.js';
import type { Word } from './types.js';

// 120 s of speech, a sentence every 10 words, words 0.5 s apart.
const words: Word[] = Array.from({ length: 240 }, (_, i) => ({
	w: i % 10 === 9 ? `word${i}.` : `word${i}`,
	s: i * 0.5,
	e: i * 0.5 + 0.4
}));
const b = { ...DEFAULT_BRAND, minSeconds: 20, maxSeconds: 60, maxClips: 2 };
let n = 0;
const ok = (cond: boolean, msg: string) => (assert.ok(cond, msg), n++, console.log(`  ✓ ${msg}`));

const lines = toLines(words);
ok(
	lines.length === 24 && lines[0].startsWith('[0.0–4.9]'),
	'transcript lines end at sentences, with times'
);

const raw = parseJson(
	'```json\n{"clips":[{"start":5,"end":35.2,"hook":"A","score":9},{"start":10,"end":40,"hook":"overlaps"},{"start":50,"end":55,"hook":"too short"},{"start":60,"end":95,"hook":"B"},{"start":100,"end":119,"hook":"third"}]}\n```'
);
const clips = validate(raw, words, b, 120);
ok(clips.length === 2, 'overlapping, too short and extra clips are dropped');
ok(clips[0].start === 4.92 && clips[0].end === 35.5, 'start and end snap to word boundaries');
ok(clips[1].hook === 'B', 'the next valid clip is kept');
ok(validate({ clips: [] }, words, b, 120).length === 0, 'an empty answer is fine');
const adjacent = validate(
	{
		clips: [
			{ start: 0, end: 25, hook: 'a' },
			{ start: 25, end: 50, hook: 'b' }
		]
	},
	words,
	b,
	120
);
ok(adjacent.length === 2, 'back-to-back clips are both kept');
assert.throws(() => parseJson('no json here'));
ok(true, 'a reply without JSON is an error');

// Cutting at pauses: two topics with a 1.2 s pause between them, breaths of 0.15 s inside.
const talk: Word[] = [];
let t = 0;
for (let i = 0; i < 60; i++) {
	if (i === 30) t += 1.2; // the topic change
	talk.push({ w: i === 29 ? 'end.' : `t${i}`, s: t, e: t + 0.3 });
	t += 0.45;
}
const pauses = [{ s: talk[29].e, e: talk[30].s }];
const pauseLen = pauses[0].e - pauses[0].s;
ok(
	parseSilences('lavfi.silence_start=12.5\nfoo\nlavfi.silence_end=13.3\n').length === 1,
	'silencedetect output is read'
);
ok(
	pickStart(talk, pauses, talk[30].s - 1)?.w === 't30',
	'a start near a pause moves to the word after the pause'
);
ok(
	pickEnd(talk, pauses, talk[29].e + 0.9)?.w === 'end.',
	'an end near a pause moves to the word before the pause'
);
const cs = cutStart(pauses, talk[30]);
const ce = cutEnd(pauses, talk[29]);
ok(
	cs.kind === 'silence' && cs.t > pauses[0].s && cs.t < talk[30].s,
	'the start is cut inside the pause, before the first word'
);
ok(talk[30].s - cs.t <= 0.21, 'with only a short lead-in of quiet');
ok(
	ce.kind === 'silence' && ce.t > talk[29].e && ce.t < pauses[0].e,
	'the end is cut inside the pause, after the last word'
);
ok(
	cutStart(pauses, talk[10]).kind === 'word',
	'without a pause the cut falls back to the word edge'
);
const lines2 = toLines(talk, pauses);
ok(
	lines2.includes(`⏸ ${pauseLen.toFixed(1)}s`),
	'Claude sees the pause and its length in the transcript'
);
const snapped = validate(
	{ clips: [{ start: talk[30].s - 0.8, end: talk[59].e, hook: 'x' }] },
	talk,
	{ ...b, minSeconds: 5 },
	40,
	pauses
);
ok(
	snapped[0]?.startCut === 'silence' && snapped[0]?.startPause === Math.round(pauseLen * 10) / 10,
	'each clip records the pause it was cut on'
);

ok(assColor('#5FD4C8') === '&H00C8D45F', 'colours convert to ASS order');
const ass = buildAss(
	words,
	{ start: 10, end: 20, hook: 'Founders for life: the long game' },
	DEFAULT_BRAND
);
ok(ass.includes('Style: Caption,Manrope ExtraBold,78'), 'captions use Manrope at the brand size');
ok(/Dialogue: 2,0:00:00\.00,0:00:03\.00,Hook/.test(ass), 'the hook shows for the brand’s seconds');
ok(
	ass.includes(`{\\c${assColor(DEFAULT_BRAND.highlightColor)}}word20`),
	'the spoken word is highlighted'
);
ok(!ass.includes('word19'), 'words outside the clip are left out');
ok(
	ass.includes('Founders for life: the\\Nlong game') &&
		!/\bN[a-z]/.test(ass.split('Hook,,')[2] ?? ''),
	'the hook wraps with real line breaks'
);

const c = cropFor(1920, 1080, 0.5);
ok(c.w === 606 && c.h === 1080 && c.x === 657, 'a 16:9 source is cropped to 9:16 around the focus');
ok(
	cropFor(1920, 1080, 0).x === 0 && cropFor(1920, 1080, 1).x === 1314,
	'focus moves the crop left and right'
);
ok(cropFor(1080, 1920, 0.5).w === 1080, 'a vertical source is kept whole');

const cand = candidateTimes({ start: 10, end: 40 }, [20, 55]);
ok(
	cand.includes(20.4) && cand.includes(21),
	'cover candidates include the moments right after a laugh'
);
ok(
	cand.every((x) => x >= 10.5 && x <= 39.5) && cand.length <= 12,
	'and stay inside the clip, at most 12'
);
const cov = coverAss('cover', 'The long game is the only game', 'Retreat 2026', DEFAULT_BRAND);
ok(
	cov.includes('RETREAT 2026') && cov.includes('The long game is\\Nthe only game'),
	'the cover has the video title and the wrapped hook'
);
ok(
	coverAss('thumbnail', 'x', 'y', DEFAULT_BRAND).includes('PlayResX: 1280'),
	'the thumbnail is 16:9'
);

console.log(`\n${n} checks passed`);
