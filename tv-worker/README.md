# FLF TV worker

Runs on a Mac. Takes the videos sent to **FLF TV** in the Hub and, for each one:

1. **Transcript**: downloads it from Google Drive, extracts the audio, transcribes it locally with
   whisper.cpp (a time for every word; laughter kept as markers).
2. **Pauses + transcript**: ffmpeg `silencedetect` measures every silence on the real audio.
3. **Topics and clips**: Claude reads the transcript with the pauses marked (`⏸ 0.8s`) and the
   **Clipping skill** saved in the Hub, maps the topics and picks the clips.
4. **Cuts, subtitles, covers**: each cut is moved inside the real pause (a short lead-in, no
   clipped word or breath), the clip is cropped to 9:16 and subtitled word by word with the
   **Brand** settings, and Claude picks the best frame (people laughing or happy) for the cover
   (1080×1920) and the thumbnail (1280×720). Everything is uploaded to the Drive folder set in
   Skill → Brand, and the Hub shows it under **Outcome**.

The video never leaves the Mac except as finished clips. Only the transcript text and a few small
frames go to Claude.

## Install (once)

```sh
brew install node ffmpeg whisper-cpp
mkdir -p ~/models && curl -L -o ~/models/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
cd ~/GitHub/flf-hub/tv-worker && npm install
```

Google (Firestore and Drive) with your own account, the one that owns the `flfhub` project:

```sh
gcloud auth application-default login --account vicente@squidmind.ai \
  --scopes=openid,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/drive
```

Claude: `ant auth login`, or `export ANTHROPIC_API_KEY=…` in the shell that runs the worker.

## Run

```sh
npm start          # keeps running, checks every 30 s
npm run once       # does what is waiting, then stops
npm test           # checks of the cutting, subtitles and covers (no network)
```

Leave `npm start` running while you want videos processed (`caffeinate -i npm start` keeps the
Mac awake). Ctrl+C stops after the current job.

## Settings (environment variables)

| Variable                              | Default                                            |                                                                 |
| ------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------- |
| `FLF_PROJECT_ID`                      | `flfhub`                                           | Firebase project                                                |
| `TV_WORK_DIR`                         | `~/FLF-TV-work`                                    | Downloads and renders; folders untouched for 7 days are removed |
| `TV_WHISPER_CMD` / `TV_WHISPER_MODEL` | `whisper-cli` / `~/models/ggml-large-v3-turbo.bin` |                                                                 |
| `TV_WHISPER_LANGUAGE`                 | `auto`                                             | e.g. `es`, `en`                                                 |
| `TV_CLAUDE_MODEL`                     | `claude-opus-5-5`                                  |                                                                 |
| `TV_POLL_SECONDS`                     | `30`                                               |                                                                 |

Test hooks (used by the emulator test, never in production): `TV_LOCAL_SOURCE`,
`TV_FAKE_TRANSCRIPT`, `TV_FAKE_CLIPS`, `TV_FAKE_FRAME`, `TV_NO_UPLOAD=1`.

## Files

`src/index.ts` the loop · `transcribe.ts` whisper and the timed lines · `silences.ts` pauses and
where to cut · `clipping.ts` Claude, the answer contract, validation and snapping · `render.ts`
crop, subtitles, hook, logo, end card · `cover.ts` best frame, cover and thumbnail · `drive.ts`.
The skills' defaults and the brand settings are defined once, in
`functions/src/lib/tv/config.ts`.
