import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What a server-side caller (the Claude connector, docs/claude-connector.md) has already
 * established about the person it acts for, carried through one call without touching a payload.
 *
 * - `via` marks what the call writes with where it came from. Only server code sets it, so a screen
 *   caller can never claim another source.
 * - `permissions` and `role` were read from the user doc and its groups at the start of the call, so
 *   the gates inside it use them instead of reading them again (same `uid` only).
 */
export interface CallContext {
	uid: string;
	role: string;
	permissions: readonly string[];
	via: string;
}

const storage = new AsyncLocalStorage<CallContext>();

/** Runs `fn` with this context; everything it awaits sees it. */
export function runWithContext<T>(context: CallContext, fn: () => Promise<T>): Promise<T> {
	return storage.run(Object.freeze({ ...context, permissions: [...context.permissions] }), fn);
}

export function callContext(): CallContext | undefined {
	return storage.getStore();
}

/** The source the running call writes as: `claude` from the connector, undefined from the screens. */
export function callVia(): string | undefined {
	return storage.getStore()?.via;
}
