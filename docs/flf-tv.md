# FLF TV

Long videos (podcast, retreat talks) → branded vertical clips with subtitles, a cover and a
thumbnail. **The Hub holds the queue, the Skill and the outcome; the Mac does the work**
(`tv-worker/`, see its README).

## In the Hub (`/tv`, permissions `tv.any.read` / `tv.any.write`)

- **Upload**: send a Google Drive link. The four steps show live: ① Transcript → ② Pauses +
  transcript → ③ Topics and clips → ④ Cuts, subtitles, covers.
- **Skill**: two editable skills the Mac reads on every video.
  - _Clipping_: what makes a good FLF clip, and above all **where to cut** (a new topic after a
    pause; the end right after the payoff, before a pause).
  - _Brand and covers_: the look, the best-frame rule for covers, and the renderer settings
    (colours, sizes, clip length, clips per video, auto-render, the Drive output folder).
    The answer format is appended in code, so editing a skill can't break the parsing.
- **Outcome**: per video, the topic map with times and every clip: hook, caption, hashtags, where
  each edge was cut (inside an N s pause, or on a word when there was none), and links to the clip,
  cover and thumbnail. Edit (times, hook, caption, framing) re-renders; reject drops it.

Claude does the same through the connector: `flf_tv_list`, `flf_tv_add_video`,
`flf_tv_update_clip`, `flf_tv_set_clip_status`, `flf_tv_get_skill`, `flf_tv_save_skill`.

## How a cut is chosen

1. whisper.cpp gives each word a start and end.
2. ffmpeg `silencedetect` (−35 dB, ≥ 0.35 s) gives the real pauses; word gaps are the fallback.
3. Claude sees the transcript as `[start–end] text` lines with `⏸ N.Ns` pause lines, and must start
   on a line that follows a pause and end on a line followed by one.
4. The code snaps to the nearest word next to a pause within 1.5 s, then cuts **inside** that
   pause: 0.2 s before the first word, 0.3 s after the last (never past the pause). It records the
   cut kind and pause length on the clip.

## Data

`tvVideo` (status `queued → processing (step) → review | failed`, `topics`), `tvTranscript`
(words as parallel arrays `w/s/e`, pauses `ss/se`, laughs `l`), `tvClip` (`suggested | approved →
rendering → rendered | rejected | failed`, cuts, links), `tvSkill/{clipping,brand}`. Actions:
`core:tv.*` (on `coreAction`, see CLAUDE.md). The worker writes with the Admin SDK through the
owner's Application Default Credentials.

## When the Mac stops mid-job

- A running job bumps `updatedAt` every 5 minutes. The worker's claim (one transaction) also takes
  a video left `processing` for 2 h or a clip left `rendering` for 1 h, sets `recoveredAt` and
  counts `attempts`; on the 3rd abandonment it marks the job `failed` (Retry / Approve again).
  It looks for these every 10 minutes when the queue is empty (one read each).
- Every command has a timeout and is killed after it: whisper 3 h, a render or an audio pass
  30 min, probes, frames and covers 2 min; a Drive download is aborted after 1 h. An error in the
  worker's loop (Firestore, network) is logged and retried after 60 s instead of stopping it.
- A video can't be retried or deleted while it is processing or one of its clips is rendering,
  nor a rendering clip edited, unless that job is past the same 2 h / 1 h limit (`STALE_MS` in
  `functions/src/lib/tv/config.ts`, imported by the worker). Each check is in the same transaction
  as its write. A job deleted anyway is logged and skipped by the worker.
- Work folder: the source downloads to `source.part` and is renamed when complete. Temp files are
  named per clip. Once no clip of a video is `suggested`, `approved` or `rendering`, its source and temp files
  are removed (one read); finished renders stay, because without a Drive folder `localPath`
  points at them, until the hourly sweep removes anything untouched for 7 days.

## Tested

`tv-worker` self-test (35 checks: cutting at pauses, snapping, validation, subtitles, crop, covers,
abandoned-job rules, command timeouts)
and an end-to-end run on the Firestore emulator with a generated video whose audio has real
silences: topics stored, both clips cut inside measured pauses, rendered 1080×1920 with captions,
hook, logo and end card, cover and thumbnail made. Not tested here: real whisper.cpp, real Claude
calls and Drive (no credentials in the build environment).
