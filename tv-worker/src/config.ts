import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const env = (k: string, d = '') => process.env[k] ?? d;

/** Everything the worker reads from the environment (see tv-worker/README.md). */
export const config = {
	projectId: env('FLF_PROJECT_ID', 'flfhub'),
	/** Where downloads, audio and renders go. Videos are deleted after each one is done. */
	workDir: env('TV_WORK_DIR', join(homedir(), 'FLF-TV-work')),
	/** whisper.cpp's CLI and a model file (brew install whisper-cpp; see README). */
	whisperCmd: env('TV_WHISPER_CMD', 'whisper-cli'),
	whisperModel: env('TV_WHISPER_MODEL', join(homedir(), 'models', 'ggml-large-v3-turbo.bin')),
	whisperLanguage: env('TV_WHISPER_LANGUAGE', 'auto'),
	ffmpeg: env('TV_FFMPEG', 'ffmpeg'),
	ffprobe: env('TV_FFPROBE', 'ffprobe'),
	model: env('TV_CLAUDE_MODEL', 'claude-opus-5-5'),
	pollSeconds: Number(env('TV_POLL_SECONDS', '30')),
	fontsDir: join(here, '..', 'assets', 'fonts'),
	logo: join(here, '..', 'assets', 'logo.png'),
	workerId: env('TV_WORKER_ID', `mac-${process.pid}`),
	// Test hooks: a local file instead of Drive, canned transcript or clips, no upload.
	localSource: env('TV_LOCAL_SOURCE'),
	fakeTranscript: env('TV_FAKE_TRANSCRIPT'),
	fakeClips: env('TV_FAKE_CLIPS'),
	/** Test hook: a frame number instead of asking Claude for the cover frame. */
	fakeFrame: env('TV_FAKE_FRAME'),
	noUpload: env('TV_NO_UPLOAD') === '1'
};
