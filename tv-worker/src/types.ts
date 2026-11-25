/** One spoken word: text, start and end in seconds. */
export type Word = { w: string; s: number; e: number };

// Brand is defined once, with its defaults, in the Hub's functions config.
export type { Brand } from '../../functions/src/lib/tv/config.js';

/** A clip as Claude proposes it, after validation. */
export interface ClipProposal {
	start: number;
	end: number;
	hook: string;
	title: string;
	caption: string;
	hashtags: string[];
	reason: string;
	score: number;
	/** How each edge was cut, and the pause it was cut in (seconds, 0 when cut on a word). */
	startCut: CutKind;
	endCut: CutKind;
	startPause: number;
	endPause: number;
}

/** A pause in the audio: start and end in seconds (ffmpeg silencedetect, or word gaps). */
export type Silence = { s: number; e: number };

/** How a clip edge was cut: inside a real pause (clean) or on a word boundary (no pause found). */
export type CutKind = 'silence' | 'word';
