/**
 * FLF TV (docs/flf-tv.md): long videos from Google Drive become branded vertical clips. The
 * heavy work (download, transcription, clip selection with Claude, rendering) runs on a Mac with
 * `tv-worker/`; the Hub holds the queue, the review and the two skills the worker reads.
 * Defined only here; the UI reads it through `tv:config.get`.
 */

export const VIDEO_COLLECTION = 'tvVideo';
export const CLIP_COLLECTION = 'tvClip';
export const TRANSCRIPT_COLLECTION = 'tvTranscript';
export const SKILL_COLLECTION = 'tvSkill';

export const VIDEO_STATUSES = ['queued', 'processing', 'review', 'failed'] as const;
export type VideoStatus = (typeof VIDEO_STATUSES)[number];

/** suggested → approved → rendering → rendered; rejected and failed are side exits. */
export const CLIP_STATUSES = [
	'suggested',
	'approved',
	'rendering',
	'rendered',
	'rejected',
	'failed'
] as const;
export type ClipStatus = (typeof CLIP_STATUSES)[number];

export const SKILL_IDS = ['clipping', 'brand'] as const;
export type SkillId = (typeof SKILL_IDS)[number];

/** Brand settings the renderer reads. Colours are #RRGGBB. */
export interface Brand {
	/** Caption text. */
	textColor: string;
	/** The word being spoken. */
	highlightColor: string;
	/** Hook card and end card background. */
	cardColor: string;
	/** Hook card text. */
	cardTextColor: string;
	/** Caption size in px on a 1080×1920 frame. */
	captionSize: number;
	/** Caption distance from the bottom, px. */
	captionMarginV: number;
	/** Words shown together on screen. */
	wordsPerLine: number;
	/** Seconds the hook card stays at the top. */
	hookSeconds: number;
	hookSize: number;
	/** Logo in the top-right corner. */
	logo: boolean;
	/** End card: seconds (0 = none) and its two lines. */
	endCardSeconds: number;
	endCardTitle: string;
	endCardCta: string;
	/** Drive folder the rendered clips are uploaded to (id from its URL). */
	outputFolderId: string;
	/** Render every proposed clip straight away (else each waits for Approve). */
	autoRender: boolean;
	/** Clip length limits and how many to propose per video. */
	minSeconds: number;
	maxSeconds: number;
	maxClips: number;
}

export const DEFAULT_BRAND: Brand = {
	textColor: '#FFFFFF',
	highlightColor: '#5FD4C8',
	cardColor: '#0F1E2E',
	cardTextColor: '#FFFFFF',
	captionSize: 78,
	captionMarginV: 520,
	wordsPerLine: 3,
	hookSeconds: 3,
	hookSize: 64,
	logo: true,
	endCardSeconds: 2,
	endCardTitle: 'Founders for Life Fellowship',
	endCardCta: 'foundersforlifefellowship.com',
	outputFolderId: '',
	autoRender: true,
	minSeconds: 20,
	maxSeconds: 75,
	maxClips: 5
};

/**
 * The Clipping skill: what makes a good FLF clip. Editable in FLF TV → Clipping; the worker reads
 * the saved version on every video. The output format is NOT here: the worker appends it in code,
 * so an edit to the skill can never break the parsing.
 */
export const DEFAULT_CLIPPING_SKILL = `# FLF TV clipping skill

You choose the moments of a long Founders for Life Fellowship video that work as short vertical
clips (Instagram Reels, TikTok, YouTube Shorts, LinkedIn).

## Who FLF is
A curated community of tech founders guided by Sherpas and Gurus: operators who built and exited
companies. A 10+ year horizon, financed by Fellows' success (a pledge of future revenue), not a
course or an accelerator. The tone is honest, calm and founder-to-founder: no hype.

## What makes a good clip
- It stands alone: someone who never saw the rest understands it.
- It opens strong: the first sentence is a claim, a surprise, a number or a question. Never
  "so", "yeah", "as I was saying".
- One idea per clip, with its payoff inside the clip.
- Concrete beats abstract: a story, a mistake, a number, a decision and why.
- Themes FLF owns: the long game, second acts, loneliness of founders, honest feedback, exits,
  pivots, what Sherpas wish they had known.

## Where to cut: the most important part
Read the transcript line by line, with the pauses (⏸) it marks, before choosing anything.
- The work happens in three passes: read the whole transcript; choose the best moments; then, for
  each one, find its exact first and last line.
- Start a clip on the first line of a new thought: right after a pause, where the speaker turns to
  a new topic or begins a story. Never in the middle of a thought, never on a filler ("so", "and",
  "um", "you know").
- End a clip right after its payoff: the line that completes the idea, followed by a pause. Never
  end on a question that is answered after the cut, or on "and…".
- The best cut points are a topic change AND a pause of half a second or more. A long pause with
  no topic change is a breath, not a boundary; a topic change with no pause means you should move
  the cut to the nearest pause.
- If a strong moment has no clean place to start or end, leave it out.

## What to avoid
- Personal or financial details about a specific Fellow (income, pledge amounts, health).
- Anything said off the record, or about someone not present, that could embarrass them.
- Clips that need the slides or the room to make sense.
- Cutting mid-sentence: start and end on sentence boundaries.

## The hook and the caption
- Hook: the on-screen title for the first seconds, 4 to 9 words, in the video's language, no
  emojis, no clickbait that the clip doesn't pay off.
- Caption: the post text, 1 to 3 short sentences that add context, then 3 to 5 hashtags.
`;

export const DEFAULT_BRAND_SKILL = `# FLF TV brand

- Colours: navy #0F1E2E (cards), FLF teal #006565 (brand), light teal #5FD4C8 (the spoken word,
  readable on video), white text.
- Type: Manrope ExtraBold for captions and the hook.
- Captions: 3 words at a time, centred in the lower third, the spoken word in light teal.
- Hook card: the first 3 seconds, top of the frame, navy box, white text.
- Logo: the FLF tile in the top-right corner, small.
- End card: 2 seconds, navy, "Founders for Life Fellowship" and the website.
- Cover (vertical, for the reel) and thumbnail (16:9, for YouTube and LinkedIn): the best frame of
  the clip, the clip's hook as the title and the video's title above it, the logo, a navy band
  behind the text.
- The best frame: people laughing or clearly happy, faces visible and in focus, eyes open, mouths
  not mid-word, all participants in shot when it is a conversation. Never a frame with closed eyes,
  motion blur, a hand over the face, or a slide.
- Framing: 9:16, 1080×1920, the speaker's face in the upper half; adjust "focus" per clip when the
  speaker is not centred.
`;
