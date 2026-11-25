import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { run } from './run.js';
import { parseJson } from './clipping.js';
import { assColor, cropFor } from './render.js';
import type { Brand } from './types.js';

/**
 * The cover (1080×1920, the reel's cover) and the thumbnail (1280×720, YouTube and LinkedIn) of a
 * clip: Claude looks at candidate frames and picks the best one (people laughing or happy, faces
 * in focus); the code draws the clip's hook, the video's title and the logo on it.
 */

/**
 * Candidate frame times inside the clip: just after each laugh (when faces light up), then evenly
 * spread, never in the first or last half second. At most `max`.
 */
export function candidateTimes(
	clip: { start: number; end: number },
	laughs: number[],
	max = 12
): number[] {
	const lo = clip.start + 0.5;
	const hi = clip.end - 0.5;
	const out: number[] = [];
	for (const l of laughs.filter((x) => x >= lo - 1 && x <= hi)) {
		for (const d of [0.4, 1.0]) if (l + d >= lo && l + d <= hi) out.push(l + d);
	}
	const even = Math.max(4, max - out.length);
	for (let i = 0; i < even; i++) out.push(lo + ((hi - lo) * (i + 0.5)) / even);
	const unique = [...new Set(out.map((t) => Math.round(t * 10) / 10))].sort((a, b) => a - b);
	return unique.slice(0, max);
}

/** One small JPEG per candidate, for Claude to look at. */
async function grabFrames(source: string, times: number[], dir: string): Promise<string[]> {
	const paths: string[] = [];
	for (const [i, t] of times.entries()) {
		const p = join(dir, `cand-${i}.jpg`);
		await run(config.ffmpeg, [
			'-y',
			'-v',
			'error',
			'-ss',
			t.toFixed(2),
			'-i',
			source,
			'-frames:v',
			'1',
			'-vf',
			'scale=640:-2',
			'-q:v',
			'4',
			p
		]);
		paths.push(p);
	}
	return paths;
}

/** Claude picks the frame; returns its index and why. */
export async function pickFrame(
	brandSkill: string,
	frames: string[],
	times: number[]
): Promise<{ index: number; why: string }> {
	if (config.fakeFrame !== '')
		return { index: Math.min(Number(config.fakeFrame), frames.length - 1), why: 'test' };
	const client = new Anthropic();
	const content: Anthropic.Beta.BetaContentBlockParam[] = [];
	frames.forEach((f, i) => {
		content.push({ type: 'text', text: `Frame ${i} (at ${times[i].toFixed(1)} s):` });
		content.push({
			type: 'image',
			source: { type: 'base64', media_type: 'image/jpeg', data: readFileSync(f).toString('base64') }
		});
	});
	content.push({
		type: 'text',
		text:
			'Choose the frame for this clip’s cover and thumbnail, following the brand skill on the best frame. ' +
			'Answer with one JSON object and nothing else: {"frame": <the frame number>, "why": "<one sentence>"}.'
	});
	const message = await client.beta.messages
		.stream({
			model: config.model,
			max_tokens: 2000,
			betas: ['server-side-fallback-2026-07-01'],
			fallbacks: 'default',
			output_config: { effort: 'low' },
			system: [{ type: 'text', text: brandSkill, cache_control: { type: 'ephemeral' } }],
			messages: [{ role: 'user', content }]
		})
		.finalMessage();
	if (message.stop_reason === 'refusal')
		return { index: 0, why: 'Claude declined; first frame used.' };
	const text = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
	const r = parseJson(text) as { frame?: unknown; why?: unknown };
	const index = Number(r.frame);
	if (!Number.isInteger(index) || index < 0 || index >= frames.length)
		return { index: 0, why: 'No valid frame chosen; first frame used.' };
	return { index, why: String(r.why ?? '').slice(0, 300) };
}

const esc = (s: string) => s.replace(/\\/g, '').replace(/[{}]/g, '').replace(/\n/g, ' ');
function wrap(text: string, max: number, lines = 3): string {
	const out: string[] = [];
	let cur = '';
	for (const w of esc(text).split(/\s+/)) {
		if ((cur + ' ' + w).trim().length > max && cur) {
			out.push(cur);
			cur = w;
		} else cur = `${cur} ${w}`.trim();
	}
	if (cur) out.push(cur);
	return out.slice(0, lines).join('\\N');
}

/** The text layer of a cover or thumbnail (ASS on a still frame). Pure, for the self-test. */
export function coverAss(
	kind: 'cover' | 'thumbnail',
	title: string,
	videoTitle: string,
	b: Brand
): string {
	const [W, H] = kind === 'cover' ? [1080, 1920] : [1280, 720];
	const titleStyle =
		kind === 'cover'
			? `Style: Title,Manrope ExtraBold,96,${assColor(b.cardTextColor)},${assColor(b.cardTextColor)},&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,1,80,80,0,1`
			: `Style: Title,Manrope ExtraBold,72,${assColor(b.cardTextColor)},${assColor(b.cardTextColor)},&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,1,64,64,0,1`;
	const kicker = `Style: Kicker,Manrope ExtraBold,${kind === 'cover' ? 44 : 32},${assColor(b.highlightColor)},${assColor(b.highlightColor)},&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,1,80,80,0,1`;
	const [kx, ky, tx, ty] = kind === 'cover' ? [80, 1260, 80, 1360] : [64, 300, 64, 370];
	return (
		[
			'[Script Info]',
			'ScriptType: v4.00+',
			`PlayResX: ${W}`,
			`PlayResY: ${H}`,
			'WrapStyle: 2',
			'',
			'[V4+ Styles]',
			'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
			titleStyle,
			kicker,
			'',
			'[Events]',
			'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
			`Dialogue: 0,0:00:00.00,0:00:10.00,Kicker,,0,0,0,,{\\an7\\pos(${kx},${ky})}${wrap(videoTitle.toUpperCase(), kind === 'cover' ? 34 : 38, 2)}`,
			`Dialogue: 0,0:00:00.00,0:00:10.00,Title,,0,0,0,,{\\an7\\pos(${tx},${ty})}${wrap(title, kind === 'cover' ? 18 : 22)}`
		].join('\n') + '\n'
	);
}

const fpath = (p: string) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

/** Draw one still: the frame, a navy band behind the text, the text, the logo. */
async function still(opts: {
	kind: 'cover' | 'thumbnail';
	source: string;
	t: number;
	width: number;
	height: number;
	focusX: number;
	title: string;
	videoTitle: string;
	brand: Brand;
	dir: string;
	out: string;
}) {
	const { kind, brand: b } = opts;
	const ass = join(opts.dir, `${kind}.ass`);
	writeFileSync(ass, coverAss(kind, opts.title, opts.videoTitle, b));
	const navy = b.cardColor.replace('#', '0x');
	let frame: string;
	let band: string;
	let logo: string;
	if (kind === 'cover') {
		const c = cropFor(opts.width, opts.height, opts.focusX);
		frame = `crop=${c.w}:${c.h}:${c.x}:${c.y},scale=1080:1920`;
		band = `drawbox=x=0:y=1180:w=iw:h=740:color=${navy}@0.82:t=fill`;
		logo = 'scale=140:140[lg];[f][lg]overlay=W-w-64:72';
	} else {
		frame = 'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720';
		band = `drawbox=x=0:y=0:w=760:h=ih:color=${navy}@0.8:t=fill`;
		logo = 'scale=96:96[lg];[f][lg]overlay=64:56';
	}
	const fonts = fpath(config.fontsDir);
	await run(config.ffmpeg, [
		'-y',
		'-v',
		'error',
		'-ss',
		opts.t.toFixed(2),
		'-i',
		opts.source,
		'-i',
		config.logo,
		'-filter_complex',
		`[0:v]${frame},${band},ass='${fpath(ass)}':fontsdir='${fonts}'[f];[1:v]${logo}`,
		'-frames:v',
		'1',
		'-q:v',
		'2',
		opts.out
	]);
}

/** Pick the best frame and draw the cover and the thumbnail. */
export async function makeCovers(opts: {
	source: string;
	width: number;
	height: number;
	clip: { start: number; end: number; hook: string; focusX?: number };
	videoTitle: string;
	laughs: number[];
	brand: Brand;
	brandSkill: string;
	dir: string;
	id: string;
}) {
	const times = candidateTimes(opts.clip, opts.laughs);
	const frames = await grabFrames(opts.source, times, opts.dir);
	const pick = await pickFrame(opts.brandSkill, frames, times);
	const t = times[pick.index];
	const common = {
		source: opts.source,
		t,
		width: opts.width,
		height: opts.height,
		focusX: opts.clip.focusX ?? 0.5,
		title: opts.clip.hook,
		videoTitle: opts.videoTitle,
		brand: opts.brand,
		dir: opts.dir
	};
	const cover = join(opts.dir, `cover-${opts.id}.jpg`);
	const thumbnail = join(opts.dir, `thumb-${opts.id}.jpg`);
	await still({ ...common, kind: 'cover', out: cover });
	await still({ ...common, kind: 'thumbnail', out: thumbnail });
	return { cover, thumbnail, frameTime: t, why: pick.why };
}
