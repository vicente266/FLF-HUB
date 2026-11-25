import { writeFileSync } from 'node:fs';
import { config } from './config.js';
import { run } from './run.js';
import type { Brand, Word } from './types.js';

const W = 1080;
const H = 1920;

/** #RRGGBB → ASS &H00BBGGRR. */
export function assColor(hex: string, alpha = 0): string {
	const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
	if (!m) throw new Error(`Bad colour ${hex}`);
	const a = alpha.toString(16).padStart(2, '0');
	return `&H${a}${m[3]}${m[2]}${m[1]}`.toUpperCase();
}

const time = (t: number) => {
	const v = Math.max(0, t);
	const h = Math.floor(v / 3600);
	const m = Math.floor((v % 3600) / 60);
	const s = (v % 60).toFixed(2).padStart(5, '0');
	return `${h}:${String(m).padStart(2, '0')}:${s}`;
};

/** Text safe inside an ASS dialogue line. */
const esc = (s: string) => s.replace(/\\/g, '').replace(/[{}]/g, '').replace(/\n/g, ' ');

/** Wrap already-escaped text into at most three lines of about `max` characters (ASS `\\N` breaks). */
function wrap(text: string, max = 22): string {
	const lines: string[] = [];
	let cur = '';
	for (const word of text.split(/\s+/)) {
		if ((cur + ' ' + word).trim().length > max && cur) {
			lines.push(cur);
			cur = word;
		} else cur = `${cur} ${word}`.trim();
	}
	if (cur) lines.push(cur);
	return lines.slice(0, 3).join('\\N');
}

/**
 * The clip's subtitles (ASS): captions of `wordsPerLine` words with the spoken word highlighted,
 * and the hook card at the top for the first seconds. Times are relative to the clip start.
 * Pure, so the self-test covers it.
 */
export function buildAss(
	words: Word[],
	clip: { start: number; end: number; hook: string },
	b: Brand
): string {
	const inClip = words.filter((w) => w.s >= clip.start - 0.05 && w.e <= clip.end + 0.05);
	// With BorderStyle 3 (opaque box) libass paints the box in the outline colour, so the hook passes
	// the card colour as both outline and back colour.
	const style = (
		name: string,
		size: number,
		primary: string,
		outlineColour: string,
		back: string,
		borderStyle: number,
		outline: number,
		align: number,
		marginV: number
	) =>
		`Style: ${name},Manrope ExtraBold,${size},${primary},${primary},${outlineColour},${back},0,0,0,0,100,100,0,0,${borderStyle},${outline},0,${align},90,90,${marginV},1`;
	const lines = [
		'[Script Info]',
		'ScriptType: v4.00+',
		`PlayResX: ${W}`,
		`PlayResY: ${H}`,
		'WrapStyle: 0',
		'',
		'[V4+ Styles]',
		'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
		style(
			'Caption',
			b.captionSize,
			assColor(b.textColor),
			assColor('#000000'),
			assColor('#000000', 0x80),
			1,
			6,
			2,
			b.captionMarginV
		),
		style(
			'Hook',
			b.hookSize,
			assColor(b.cardTextColor),
			assColor(b.cardColor),
			assColor(b.cardColor),
			3,
			26,
			8,
			220
		),
		'',
		'[Events]',
		'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
	];
	const hi = assColor(b.highlightColor);
	const base = assColor(b.textColor);
	for (let i = 0; i < inClip.length; i += b.wordsPerLine) {
		const group = inClip.slice(i, i + b.wordsPerLine);
		group.forEach((w, j) => {
			const from = w.s - clip.start;
			const next = group[j + 1] ?? inClip[i + b.wordsPerLine];
			// Hold until the next word starts (or a moment after the last word of the group).
			const to = (next ? Math.min(next.s, w.e + 0.6) : w.e + 0.3) - clip.start;
			const text = group
				.map((g, k) => (k === j ? `{\\c${hi}}${esc(g.w)}{\\c${base}}` : esc(g.w)))
				.join(' ');
			lines.push(
				`Dialogue: 1,${time(from)},${time(Math.max(to, from + 0.05))},Caption,,0,0,0,,${text}`
			);
		});
	}
	if (clip.hook && b.hookSeconds > 0) {
		lines.push(
			`Dialogue: 2,${time(0)},${time(b.hookSeconds)},Hook,,0,0,0,,{\\fad(150,250)}${wrap(esc(clip.hook))}`
		);
	}
	return lines.join('\n') + '\n';
}

/** The end card's two lines, centred on the card colour. */
export function buildEndCardAss(b: Brand): string {
	const s = (name: string, size: number, color: string, marginV: number) =>
		`Style: ${name},Manrope ExtraBold,${size},${assColor(color)},${assColor(color)},&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,90,90,${marginV},1`;
	return (
		[
			'[Script Info]',
			'ScriptType: v4.00+',
			`PlayResX: ${W}`,
			`PlayResY: ${H}`,
			'',
			'[V4+ Styles]',
			'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
			s('Title', 72, b.cardTextColor, 0),
			s('Cta', 44, b.highlightColor, 0),
			'',
			'[Events]',
			'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
			`Dialogue: 0,${time(0)},${time(b.endCardSeconds)},Title,,0,0,0,,{\\pos(540,1060)\\fad(200,0)}${wrap(esc(b.endCardTitle), 20)}`,
			`Dialogue: 0,${time(0)},${time(b.endCardSeconds)},Cta,,0,0,0,,{\\pos(540,1260)\\fad(300,0)}${esc(b.endCardCta)}`
		].join('\n') + '\n'
	);
}

/** The crop that turns the source into 9:16 around `focusX` (0 left … 1 right). */
export function cropFor(width: number, height: number, focusX: number) {
	if (width / height > W / H) {
		const cw = Math.floor((height * W) / H / 2) * 2;
		return {
			w: cw,
			h: height,
			x: Math.round((width - cw) * Math.min(1, Math.max(0, focusX))),
			y: 0
		};
	}
	const ch = Math.min(height, Math.floor((width * H) / W / 2) * 2);
	return { w: width, h: ch, x: 0, y: Math.round((height - ch) * 0.3) };
}

/** Paths inside an ffmpeg filter need ':' , '\\' and quotes escaped. */
const fpath = (p: string) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

/**
 * Render one clip to a 1080×1920 H.264 MP4: crop to 9:16, captions and hook, logo, end card.
 */
export async function renderClip(opts: {
	source: string;
	width: number;
	height: number;
	clip: { start: number; end: number; hook: string; focusX?: number };
	words: Word[];
	brand: Brand;
	assPath: string;
	endAssPath: string;
	out: string;
}) {
	const { clip, brand: b } = opts;
	writeFileSync(opts.assPath, buildAss(opts.words, clip, b));
	const crop = cropFor(opts.width, opts.height, clip.focusX ?? 0.5);
	const dur = (clip.end - clip.start).toFixed(3);
	const fonts = fpath(config.fontsDir);
	const main = `[0:v]crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=${W}:${H},fps=30,setsar=1,ass='${fpath(opts.assPath)}':fontsdir='${fonts}'`;
	const args = ['-y', '-v', 'error', '-ss', clip.start.toFixed(3), '-t', dur, '-i', opts.source];
	let filter: string;
	let inputs = 1;
	const logo = b.logo ? inputs++ : -1;
	if (b.logo) args.push('-i', config.logo);
	const withLogo = b.logo
		? `${main}[m];[${logo}:v]scale=120:120,format=rgba,colorchannelmixer=aa=0.9[lg];[m][lg]overlay=W-w-56:72,format=yuv420p[v0]`
		: `${main},format=yuv420p[v0]`;
	if (b.endCardSeconds > 0) {
		writeFileSync(opts.endAssPath, buildEndCardAss(b));
		// The end card's picture and silence are the next two inputs.
		const card = inputs;
		const silence = inputs + 1;
		args.push(
			'-f',
			'lavfi',
			'-i',
			`color=c=${b.cardColor.replace('#', '0x')}:s=${W}x${H}:r=30:d=${b.endCardSeconds}`
		);
		args.push('-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo:d=${b.endCardSeconds}`);
		filter =
			`${withLogo};` +
			`[${card}:v]setsar=1,ass='${fpath(opts.endAssPath)}':fontsdir='${fonts}',format=yuv420p[v1];` +
			`[0:a]aresample=48000,aformat=channel_layouts=stereo[a0];[${silence}:a]aformat=channel_layouts=stereo[a1];` +
			`[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]`;
	} else {
		filter = `${withLogo};[0:a]aresample=48000[a]`;
		filter = filter.replace('[v0]', '[v]');
	}
	args.push(
		'-filter_complex',
		filter,
		'-map',
		'[v]',
		'-map',
		'[a]',
		'-c:v',
		'libx264',
		'-preset',
		'medium',
		'-crf',
		'20',
		'-pix_fmt',
		'yuv420p',
		'-c:a',
		'aac',
		'-b:a',
		'160k',
		'-movflags',
		'+faststart',
		opts.out
	);
	await run(config.ffmpeg, args);
}
