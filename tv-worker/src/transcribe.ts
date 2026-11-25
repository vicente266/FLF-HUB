import { readFileSync } from 'node:fs';
import { config } from './config.js';
import { run, TIMEOUT } from './run.js';
import type { Silence, Word } from './types.js';
import { gapsFromWords, pauseAfter } from './silences.js';

/** The video's length in seconds and its frame size. */
export async function probe(path: string) {
	const out = await run(
		config.ffprobe,
		[
			'-v',
			'error',
			'-select_streams',
			'v:0',
			'-show_entries',
			'stream=width,height:format=duration',
			'-of',
			'json',
			path
		],
		TIMEOUT.probe
	);
	const j = JSON.parse(out) as {
		streams?: { width: number; height: number }[];
		format?: { duration?: string };
	};
	const s = j.streams?.[0];
	if (!s) throw new Error('No video stream in the file.');
	return { width: s.width, height: s.height, duration: Number(j.format?.duration ?? 0) };
}

/** 16 kHz mono WAV, what whisper.cpp reads. */
export async function extractAudio(video: string, wav: string) {
	await run(
		config.ffmpeg,
		['-y', '-v', 'error', '-i', video, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav],
		TIMEOUT.ffmpeg
	);
}

/**
 * Word-level transcript with whisper.cpp, locally (no audio leaves the Mac). One word per segment
 * (`--max-len 1 --split-on-word`), JSON output.
 */
/** Laughter as whisper writes it: [laughter], (laughs), *laughing*… */
const LAUGH = /^[[(*]?\s*(laugh\w*|risas?|ríe\w*)\s*[\])*]?$/i;

/**
 * Word-level transcript with whisper.cpp, locally (no audio leaves the Mac). One word per segment
 * (`--max-len 1 --split-on-word`), JSON output. Laughter markers are taken out of the words and
 * returned apart: they point at the frames for the cover.
 */
export async function transcribe(
	wav: string,
	outBase: string
): Promise<{ words: Word[]; laughs: number[] }> {
	let raw: Word[];
	if (config.fakeTranscript)
		raw = JSON.parse(readFileSync(config.fakeTranscript, 'utf8')) as Word[];
	else {
		await run(
			config.whisperCmd,
			[
				'-m',
				config.whisperModel,
				'-f',
				wav,
				'-l',
				config.whisperLanguage,
				'--max-len',
				'1',
				'--split-on-word',
				'--output-json',
				'--output-file',
				outBase,
				'--no-prints'
			],
			TIMEOUT.whisper
		);
		const j = JSON.parse(readFileSync(`${outBase}.json`, 'utf8')) as {
			transcription: { offsets: { from: number; to: number }; text: string }[];
		};
		raw = j.transcription.map((t) => ({
			w: t.text.trim(),
			s: t.offsets.from / 1000,
			e: t.offsets.to / 1000
		}));
	}
	const laughs = raw.filter((w) => LAUGH.test(w.w)).map((w) => w.s);
	const words = raw.filter((w) => w.w && !LAUGH.test(w.w) && !/^[[(].*[\])]$/.test(w.w));
	return { words, laughs };
}

/**
 * The transcript as Claude reads it: one line per stretch of speech, a line ends at sentence
 * punctuation or at a pause, and every pause of `MIN_PAUSE` or more is its own marker line with its
 * length, so Claude can see where the speaker stops and pick cuts at a pause + change of topic.
 *   [84.3–91.0] text…
 *   ⏸ 0.8s
 */
export function toLines(
	words: Word[],
	silences: Silence[] = gapsFromWords(words),
	maxWords = 40
): string[] {
	const lines: string[] = [];
	let cur: Word[] = [];
	const flush = () => {
		if (!cur.length) return;
		lines.push(
			`[${cur[0].s.toFixed(1)}–${cur[cur.length - 1].e.toFixed(1)}] ${cur.map((w) => w.w).join(' ')}`
		);
		cur = [];
	};
	words.forEach((w, i) => {
		cur.push(w);
		const next = words[i + 1];
		const pause = next ? pauseAfter(silences, w.e) : undefined;
		if (pause && next && pause.e <= next.s + 0.15) {
			flush();
			lines.push(`⏸ ${(pause.e - pause.s).toFixed(1)}s`);
		} else if (/[.!?…]$/.test(w.w) || cur.length >= maxWords) flush();
	});
	flush();
	return lines;
}
