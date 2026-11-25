import { httpsCallable, type HttpsCallableOptions } from 'firebase/functions';
import { functions } from '$lib/firebase';

/** `<feature>:<action>` — the feature resolves to the `<feature>Action` callable. */
export type ActionTarget = `${string}:${string}`;

/**
 * Call one action of a feature dispatcher and return its data. The only place the app calls a
 * function: the backend exposes one callable per feature (functions/src/dispatch.ts).
 */
export async function callAction<Res = unknown>(
	target: ActionTarget,
	payload: Record<string, unknown> = {},
	options?: HttpsCallableOptions
): Promise<Res> {
	const [feature, action] = target.split(':');
	const fn = httpsCallable<{ action: string; payload: unknown }, Res>(
		functions,
		`${feature}Action`,
		options
	);
	return (await fn({ action, payload })).data;
}

/** A readable message from a failed call, without a trailing ` [code]` meant for logs. */
export function errorText(err: unknown): string {
	if (err && typeof err === 'object' && 'message' in err) {
		const text = String(err.message)
			.replace(/\s*\[[^\]\s]+\]\.?\s*$/, '')
			.trim();
		if (text) return text;
	}
	return 'Something went wrong. Try again.';
}
