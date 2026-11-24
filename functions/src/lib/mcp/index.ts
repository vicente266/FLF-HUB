import { HttpsError } from 'firebase-functions/v2/https';
import type { CallerAuth } from './caller';
import { keysFrom, type Keys } from './crypto';
import {
	OAuthError,
	approve,
	checkAuthorize,
	describeRedirect,
	endAllOf,
	endConnection,
	listAll,
	listOwn,
	withQuery
} from './oauth';

/**
 * The FLF Hub connector for Claude (docs/claude-connector.md). `server.handle` answers the connector's
 * own endpoint; the functions below are what the Hub's pages call through `coreAction`.
 */
export { handle } from './server';
export { cleanUp } from './caller';
export { keysFrom } from './crypto';
export { CONNECTOR_URL } from './config';

/** The consent page's question as the page shows it: which app, and where it sends you back. */
function consentParams(payload: Record<string, unknown>) {
	const p = (payload ?? {}) as Record<string, unknown>;
	const server = String(p.server ?? '');
	// The resource a client may ask for is this server's own address. /authorize checked it; the
	// page passes back the server /authorize named, so the check here only repeats that one.
	if (!/^https?:\/\/[^\s]+$/.test(server)) {
		throw new HttpsError('invalid-argument', 'This sign-in link is not valid.');
	}
	return { params: p, resourceUrl: `${server.replace(/\/$/, '')}/mcp` };
}

function asHttps(e: unknown): never {
	if (e instanceof OAuthError) throw new HttpsError('invalid-argument', e.description);
	throw e;
}

/** `claude.client`: who asks, for the consent page. Nothing is written. */
export function describeClient(keys: Keys, payload: Record<string, unknown>) {
	const { params, resourceUrl } = consentParams(payload);
	try {
		const { client, request, error } = checkAuthorize(keys, params, resourceUrl);
		return {
			name: client.name,
			sendsTo: describeRedirect(request.redirectUri),
			registeredAt: client.issuedAt ? new Date(client.issuedAt * 1000).toISOString() : null,
			error: error?.description ?? null,
			// Cancel sends the person back to the app with "access denied", built here from the
			// redirect address just checked, never from what the page holds.
			denyUrl: withQuery(request.redirectUri, { error: 'access_denied', state: request.state })
		};
	} catch (e) {
		return asHttps(e);
	}
}

/** `claude.approve`: the person approves; returns where to send them, with the code. */
export async function approveClient(
	keys: Keys,
	payload: Record<string, unknown>,
	auth: CallerAuth
) {
	const { params, resourceUrl } = consentParams(payload);
	const authTime = Number((auth.token as { auth_time?: unknown }).auth_time ?? 0);
	try {
		return await approve(keys, params, { uid: auth.uid, authTime }, resourceUrl);
	} catch (e) {
		return asHttps(e);
	}
}

export const connections = {
	own: (auth: CallerAuth) => listOwn(auth.uid),
	end: (id: unknown, auth: CallerAuth) => endConnection(id, { uid: auth.uid, admin: false }),
	all: () => listAll(),
	revoke: (id: unknown) => endConnection(id, { uid: '', admin: true }),
	revokePerson: (uid: unknown) => endAllOf(uid)
};

/** The keys, from the secret, made once per instance. */
let cached: { secret: string; keys: Keys } | null = null;
export function keys(secret: string): Keys {
	if (!cached || cached.secret !== secret) cached = { secret, keys: keysFrom(secret) };
	return cached.keys;
}
