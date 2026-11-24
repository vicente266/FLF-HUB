import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import * as utils from './lib/utils';
import { callContext } from './lib/call-context';

/** One routable action of a feature dispatcher. */
export interface Action {
	/** Permission required to run it (admins always pass). Omit to allow any signed-in user. */
	permission?: string;
	/** Gate on `role === 'admin'` instead of a permission string. */
	adminOnly?: boolean;
	/** Message returned when the gate rejects. */
	denied?: string;
	handler: (payload: any, auth: any) => Promise<unknown>;
}

/** Every feature's action map, so the Claude connector runs the same actions through `runAction`. */
const registry = new Map<string, Record<string, Action>>();

/**
 * Build the handler of a feature's single `<feature>Action` callable: routes `{ action, payload }`
 * to one entry of `actions` and applies that entry's gate. One callable per feature keeps a full
 * deploy under the Cloud Functions mutation quota (60/min/region, not raisable).
 */
export function dispatch(feature: string, actions: Record<string, Action>) {
	registry.set(feature, actions);
	return async (request: CallableRequest<any>) =>
		execute(feature, actions, request.data?.action, request.data?.payload ?? {}, request.auth);
}

/**
 * Run one action of a feature as `auth`, with its gate and log line, exactly as its callable does.
 * For server-side callers that have already verified who `auth` is: the Claude connector.
 */
export async function runAction(
	feature: string,
	name: string,
	payload: Record<string, unknown>,
	auth: any
): Promise<unknown> {
	const actions = registry.get(feature);
	if (!actions) throw new HttpsError('internal', `No actions for '${feature}'.`);
	return execute(feature, actions, name, payload, auth);
}

/** The role the gate checks: the connector's, read from the user doc, else the token claim. */
function roleOf(auth: any): string | undefined {
	const ctx = callContext();
	return ctx && ctx.uid === auth?.uid ? ctx.role : auth?.token?.role;
}

async function execute(
	feature: string,
	actions: Record<string, Action>,
	name: unknown,
	payload: unknown,
	auth: any
): Promise<unknown> {
	if (typeof name !== 'string' || !name) {
		throw new HttpsError('invalid-argument', 'Missing action.');
	}
	const action = Object.hasOwn(actions, name) ? actions[name] : undefined;
	if (!action) {
		throw new HttpsError(
			'invalid-argument',
			`Unknown action '${name}'. Reload the page: the Hub has probably been updated.`
		);
	}
	if (!auth?.uid) throw new HttpsError('unauthenticated', 'You must be signed in.');
	if (action.adminOnly && roleOf(auth) !== 'admin') {
		throw new HttpsError('permission-denied', action.denied ?? 'Only admins can do this.');
	}
	if (action.permission && !(await utils.hasPermission(auth, action.permission))) {
		throw new HttpsError(
			'permission-denied',
			action.denied ?? 'You do not have permission to do this.'
		);
	}

	const scoped = utils.createLogger(feature).scope(name);
	const startedAt = Date.now();
	try {
		const result = await action.handler(payload ?? {}, auth);
		scoped.log(`ok in ${Date.now() - startedAt}ms${callContext() ? ' via claude' : ''}`);
		return result;
	} catch (err) {
		scoped.error(`failed in ${Date.now() - startedAt}ms`, err);
		if (err instanceof HttpsError) throw err;
		throw new HttpsError('internal', err instanceof Error ? err.message : 'Internal error.');
	}
}
