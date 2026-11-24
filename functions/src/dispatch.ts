import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https';
import * as utils from './lib/utils';

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

/**
 * Build the handler of a feature's single `<feature>Action` callable: routes `{ action, payload }`
 * to one entry of `actions` and applies that entry's gate. One callable per feature keeps a full
 * deploy under the Cloud Functions mutation quota (60/min/region, not raisable).
 */
export function dispatch(feature: string, actions: Record<string, Action>) {
	const logger = utils.createLogger(feature);

	return async (request: CallableRequest<any>) => {
		const auth = request.auth;
		const name = request.data?.action;
		if (typeof name !== 'string' || !name)
			throw new HttpsError('invalid-argument', 'Missing action.');

		const action = actions[name];
		if (!action) {
			throw new HttpsError(
				'invalid-argument',
				`Unknown action '${name}'. Reload the page: the Hub has probably been updated.`
			);
		}
		if (!auth?.uid) throw new HttpsError('unauthenticated', 'You must be signed in.');
		if (action.adminOnly && auth.token.role !== 'admin') {
			throw new HttpsError('permission-denied', action.denied ?? 'Only admins can do this.');
		}
		if (action.permission && !(await utils.hasPermission(auth, action.permission))) {
			throw new HttpsError(
				'permission-denied',
				action.denied ?? 'You do not have permission to do this.'
			);
		}

		const scoped = logger.scope(name);
		const startedAt = Date.now();
		try {
			const result = await action.handler(request.data?.payload ?? {}, auth);
			scoped.log(`ok in ${Date.now() - startedAt}ms`);
			return result;
		} catch (err) {
			scoped.error(`failed in ${Date.now() - startedAt}ms`, err);
			if (err instanceof HttpsError) throw err;
			throw new HttpsError('internal', err instanceof Error ? err.message : 'Internal error.');
		}
	};
}
