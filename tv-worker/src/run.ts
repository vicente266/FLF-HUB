import { spawn } from 'node:child_process';

/** How long each kind of command may run before it is killed. */
export const TIMEOUT = {
	/** ffprobe, one frame grab, one cover. */
	probe: 2 * 60_000,
	/** One clip render, or one pass over a video's audio. */
	ffmpeg: 30 * 60_000,
	/** whisper.cpp on a whole video. */
	whisper: 3 * 3_600_000
} as const;

/**
 * Run a command, resolve with stdout; reject with the end of stderr. Never through a shell.
 * After `timeoutMs` the command is killed (SIGKILL) and the promise rejects.
 */
export function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '';
		let err = '';
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			p.kill('SIGKILL');
		}, timeoutMs);
		p.stdout.on('data', (d) => (out += d));
		p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
		p.on('error', (e) => {
			clearTimeout(timer);
			reject(new Error(`${cmd} could not start: ${e.message}`));
		});
		p.on('close', (code) => {
			clearTimeout(timer);
			if (timedOut) {
				reject(
					new Error(`${cmd} ran longer than ${Math.round(timeoutMs / 60_000)} min and was stopped.`)
				);
			} else if (code === 0) resolve(out);
			else {
				reject(new Error(`${cmd} failed (${code}): ${err.trim().split('\n').slice(-3).join(' ')}`));
			}
		});
	});
}
