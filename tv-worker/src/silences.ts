import { config } from './config.js';
import { run, TIMEOUT } from './run.js';
import type { CutKind, Silence, Word } from './types.js';

/** Pauses shorter than this are breaths inside a sentence, not places to cut. */
export const MIN_PAUSE = 0.35;

/**
 * Every pause in the audio, from ffmpeg's silencedetect on the real signal (more exact than the
 * transcript's word times, which drift by a tenth of a second or so).
 */
export async function detectSilences(audio: string, noiseDb = -35): Promise<Silence[]> {
	// silencedetect logs to stderr; run() only keeps the tail, so ask ffmpeg to print to stdout.
	const out = await run(
		config.ffmpeg,
		[
			'-hide_banner',
			'-nostats',
			'-i',
			audio,
			'-af',
			`silencedetect=noise=${noiseDb}dB:d=${MIN_PAUSE},ametadata=mode=print:file=-`,
			'-f',
			'null',
			'-'
		],
		TIMEOUT.ffmpeg
	);
	return parseSilences(out);
}

/** Parses ametadata's `lavfi.silence_start=` / `lavfi.silence_end=` lines. */
export function parseSilences(text: string): Silence[] {
	const out: Silence[] = [];
	let start: number | null = null;
	for (const line of text.split('\n')) {
		const a = /lavfi\.silence_start=([\d.]+)/.exec(line);
		const b = /lavfi\.silence_end=([\d.]+)/.exec(line);
		if (a) start = Number(a[1]);
		if (b && start !== null) {
			out.push({ s: start, e: Number(b[1]) });
			start = null;
		}
	}
	return out;
}

/** Fallback when silencedetect finds nothing (music bed, noisy room): gaps between words. */
export function gapsFromWords(words: Word[]): Silence[] {
	const out: Silence[] = [];
	for (let i = 1; i < words.length; i++) {
		if (words[i].s - words[i - 1].e >= MIN_PAUSE) out.push({ s: words[i - 1].e, e: words[i].s });
	}
	return out;
}

/** The pause just before word `i`, if any (the gap that ends where the word starts). */
export function pauseBefore(silences: Silence[], wordStart: number): Silence | undefined {
	return silences.find(
		(p) => p.e >= wordStart - 0.4 && p.e <= wordStart + 0.15 && p.e - p.s >= MIN_PAUSE
	);
}

/** The pause just after a word ending at `wordEnd`, if any. */
export function pauseAfter(silences: Silence[], wordEnd: number): Silence | undefined {
	return silences.find(
		(p) => p.s >= wordEnd - 0.15 && p.s <= wordEnd + 0.4 && p.e - p.s >= MIN_PAUSE
	);
}

/**
 * Where to cut. A start is cut late in the pause before the first word (a short lead-in of quiet,
 * no breath or previous word); an end early in the pause after the last word (the sentence rings
 * out, no dead air). Without a pause, a small margin around the word.
 */
export function cutStart(
	silences: Silence[],
	word: Word
): { t: number; kind: CutKind; pause: number } {
	const p = pauseBefore(silences, word.s);
	if (p) return { t: Math.max(p.s, p.e - 0.2), kind: 'silence', pause: p.e - p.s };
	return { t: Math.max(0, word.s - 0.08), kind: 'word', pause: 0 };
}

export function cutEnd(
	silences: Silence[],
	word: Word
): { t: number; kind: CutKind; pause: number } {
	const p = pauseAfter(silences, word.e);
	if (p) return { t: Math.min(p.e, p.s + 0.3), kind: 'silence', pause: p.e - p.s };
	return { t: word.e + 0.1, kind: 'word', pause: 0 };
}
