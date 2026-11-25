/** Today as `YYYY-MM-DD` (UTC), matching the backend's string comparison of ISO dates. */
export const todayIso = () => new Date().toISOString().slice(0, 10);

/** Expired once its `expiredAt` day has passed, as the backend decides (functions/src/lib/knowledge). */
export function isExpired(entry: { expiredAt?: string }, today = todayIso()): boolean {
	return !!entry.expiredAt && entry.expiredAt < today;
}
