/** Rules for jobs left behind by a worker that stopped (sleep, reboot, crash). Pure, self-tested. */

// When a job counts as abandoned is defined once, next to the Hub actions that also use it.
export { STALE_MS } from '../../functions/src/lib/tv/config.js';

/** A live job bumps `updatedAt` this often, far inside the stale limits above. */
export const HEARTBEAT_MS = 5 * 60_000;

/** Tries per job (the first claim counts as one) before it is marked failed. */
export const MAX_ATTEMPTS = 3;

/** How often the claim also looks for abandoned jobs (each look is a billed read). */
export const STALE_CHECK_MS = 10 * 60_000;

/** What to do with an abandoned job that has been tried `attempts` times (missing = once). */
export function recoverDecision(attempts: number | undefined): 'retry' | 'fail' {
	return (attempts ?? 1) >= MAX_ATTEMPTS ? 'fail' : 'retry';
}

/**
 * Files in a video's work folder that are a finished render (clip, cover, thumbnail). Without a
 * Drive folder their `localPath` is the only copy, so they stay until the 7-day sweep.
 */
export const isRenderOutput = (name: string) =>
	/^(clip-.+\.mp4|cover-.+\.jpg|thumb-.+\.jpg)$/.test(name);
