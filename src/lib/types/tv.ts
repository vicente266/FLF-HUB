/** Shapes of FLF TV documents and of `core:tv.*` answers (defined in functions/src/lib/tv). */

export interface TvVideo {
	id: string;
	title: string;
	driveFileId: string;
	driveUrl: string;
	status: string;
	step: string | null;
	error: string | null;
	durationSec: number | null;
	clipCount: number;
	/** The video's topics in order, from Claude (step ③). */
	topics?: { start: number; end: number; title: string; summary: string }[];
	createdBy: string;
	createdAt: unknown;
}

export interface TvClip {
	id: string;
	videoId: string;
	videoTitle: string;
	index: number;
	start: number;
	end: number;
	hook: string;
	title: string;
	caption: string;
	hashtags: string[];
	reason: string;
	score: number;
	focusX: number;
	status: string;
	/** How each edge was cut: inside a pause of startPause/endPause seconds, or on a word. */
	startCut?: 'silence' | 'word';
	endCut?: 'silence' | 'word';
	startPause?: number;
	endPause?: number;
	renderUrl: string | null;
	localPath?: string | null;
	coverUrl?: string | null;
	thumbnailUrl?: string | null;
	coverLocal?: string | null;
	thumbnailLocal?: string | null;
	coverWhy?: string;
	error: string | null;
	updatedBy?: string;
}

/** The brand settings the renderer reads; the keys and defaults come from `tv.config.get`. */
export type TvBrand = Record<string, string | number | boolean>;

export interface TvSkill {
	id: 'clipping' | 'brand';
	text: string;
	brand?: TvBrand;
	version: number;
	updatedBy: string | null;
	updatedAt: number | null;
	isDefault: boolean;
}
