import { HttpsError } from 'firebase-functions/v2/https';
import { db } from '../../firestore';
import { serverTimestamp } from '../utils';
import {
	ACCESS_TOKEN_SECONDS,
	CALLBACKS,
	CODE_COLLECTION,
	CODE_SECONDS,
	CONNECTION_COLLECTION,
	CONNECTION_DAYS,
	FRESH_SIGN_IN_SECONDS,
	REFRESH_TOKEN_DAYS,
	RETRY_SECONDS
} from './config';
import {
	b64url,
	hmac,
	pkceChallenge,
	randomId,
	same,
	seal,
	sha256,
	unseal,
	type Keys
} from './crypto';
import { onlyThisConnection, requireCaller, revokeAll, type Caller } from './caller';

/**
 * The connector's OAuth 2.1 server (docs/claude-connector.md, "Sign-in"): stateless client
 * registration, single-use sign-in codes bound to the client, its redirect and the PKCE challenge,
 * and one row per connection with rotating refresh tokens.
 *
 * Errors meant for the client carry an OAuth `error` code in `OAuthError`; the HTTP layer turns
 * them into the RFC 6749 JSON answer.
 */
export class OAuthError extends Error {
	constructor(
		readonly error: string,
		readonly description: string,
		readonly status = 400
	) {
		super(description);
	}
}

const connections = () => db.collection(CONNECTION_COLLECTION);

/** A connection's id: `randomId(18)`, 24 base64url characters. Anything else is refused unread. */
const ROW_ID = /^[A-Za-z0-9_-]{24}$/;

/** Whether the gate gave a definite "no" (caller.ts), not a passing failure. */
const refused = (e: unknown) => e instanceof HttpsError && e.code === 'permission-denied';

/**
 * A passing failure (Firestore, Auth) at /token: the client tries again later, nothing is ended,
 * and it is never a reason to sign in anew.
 */
export const tryLater = () =>
	new OAuthError('temporarily_unavailable', 'Try again in a moment.', 503);
const codes = () => db.collection(CODE_COLLECTION);

// -- clients and redirects -------------------------------------------------------------------

/** A registered client, as its signed id carries it. */
export interface Client {
	name: string;
	redirectUris: string[];
	/** When it registered, in seconds: the consent page shows it. */
	issuedAt: number;
}

/** A loopback address, as Claude Code signs in through: http, on localhost, 127.0.0.1 or [::1]. */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
function loopback(uri: URL): boolean {
	return uri.protocol === 'http:' && LOOPBACK_HOSTS.includes(uri.hostname);
}

function parseUri(value: unknown): URL | null {
	try {
		const url = new URL(String(value ?? ''));
		// No credentials or fragments in a redirect address (RFC 6749 §3.1.2).
		if (url.username || url.password || url.hash) return null;
		return url;
	} catch {
		return null;
	}
}

/** A redirect address the connector accepts at all: claude.ai's callback or a loopback one. */
export function allowedRedirect(value: unknown): boolean {
	const url = parseUri(value);
	if (!url) return false;
	if (loopback(url)) return true;
	return CALLBACKS.includes(url.href);
}

/**
 * Whether `asked` matches one of the client's registered addresses: exactly, except a loopback
 * address's port, which Claude Code picks fresh for each sign-in (RFC 8252 §7.3).
 */
export function redirectMatches(client: Client, asked: unknown): boolean {
	const url = parseUri(asked);
	if (!url || !allowedRedirect(url.href)) return false;
	return client.redirectUris.some((registered) => {
		if (registered === url.href) return true;
		const reg = parseUri(registered);
		if (!reg || !loopback(reg) || !loopback(url)) return false;
		return (
			reg.hostname === url.hostname && reg.pathname === url.pathname && reg.search === url.search
		);
	});
}

/** Where a client sends the person back, in words the consent page shows. */
export function describeRedirect(uri: string): string {
	const url = parseUri(uri);
	if (!url) return 'an unknown address';
	// Any program on the computer can register a loopback address, so it is never named Claude Code.
	if (loopback(url)) return 'an app on this computer';
	return url.hostname;
}

function cleanName(value: unknown): string {
	// Printable characters only: no control or format characters (a direction override would turn
	// the rest of the consent sentence round), no line breaks, and no angle brackets.
	const name = [...String(value ?? '')]
		.filter((ch) => !/[\p{C}\p{Zl}\p{Zp}<>]/u.test(ch))
		.join('')
		.trim()
		.slice(0, 80);
	return name || 'An unnamed app';
}

/**
 * Registers a client (RFC 7591) without writing anything: the id it gets is signed and carries its
 * name and redirect addresses, so an open registration route costs no Firestore write.
 */
export function registerClient(keys: Keys, body: unknown): Record<string, unknown> {
	const raw = (body ?? {}) as Record<string, unknown>;
	const uris = Array.isArray(raw.redirect_uris) ? raw.redirect_uris.map(String) : [];
	if (!uris.length || uris.length > 5) {
		throw new OAuthError('invalid_redirect_uri', 'Give one to five redirect addresses.');
	}
	for (const uri of uris) {
		if (!allowedRedirect(uri)) {
			throw new OAuthError(
				'invalid_redirect_uri',
				'Only claude.ai’s callback or a loopback address (Claude Code) can be registered.'
			);
		}
	}
	// Every client here is public (no secret). A client that asks for another method still gets
	// one, registered as `none`: the server may replace a requested value (RFC 7591 §3.2.1), and
	// the answer says what was registered.
	const issuedAt = Math.floor(Date.now() / 1000);
	const client: Client = { name: cleanName(raw.client_name), redirectUris: uris, issuedAt };
	const payload = b64url(Buffer.from(JSON.stringify({ n: client.name, r: uris, t: issuedAt })));
	return {
		client_id: `${payload}.${hmac(keys.client, `client.${payload}`)}`,
		client_id_issued_at: issuedAt,
		client_name: client.name,
		redirect_uris: uris,
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
		token_endpoint_auth_method: 'none'
	};
}

/** The client a signed id names, or an error when the id was not made here. */
export function readClient(keys: Keys, clientId: unknown): Client {
	const [payload, tag, extra] = String(clientId ?? '').split('.');
	if (
		!payload ||
		!tag ||
		extra !== undefined ||
		!same(tag, hmac(keys.client, `client.${payload}`))
	) {
		throw new OAuthError('invalid_client', 'Unknown client.', 401);
	}
	const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
		n: string;
		r: string[];
		t: number;
	};
	return { name: data.n, redirectUris: data.r, issuedAt: Number(data.t) || 0 };
}

// -- authorize: checked here, approved on the Hub's consent page ---------------------------------

/** What /authorize was asked, once checked. */
export interface AuthorizeRequest {
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	state: string;
	resource: string;
}

/**
 * Checks an /authorize request. Throws `OAuthError` when the client or its redirect address can't
 * be trusted (the person must not be sent there); any other problem is returned as
 * `error`, to send back to that redirect address.
 */
export function checkAuthorize(
	keys: Keys,
	params: Record<string, unknown>,
	resourceUrl: string
): { request: AuthorizeRequest; client: Client; error?: OAuthError } {
	const clientId = String(params.client_id ?? '');
	const client = readClient(keys, clientId);
	const redirectUri = String(params.redirect_uri ?? '');
	if (!redirectMatches(client, redirectUri)) {
		throw new OAuthError(
			'invalid_request',
			'That redirect address is not registered for this app.'
		);
	}
	const request: AuthorizeRequest = {
		clientId,
		redirectUri,
		codeChallenge: String(params.code_challenge ?? ''),
		// Exactly as sent: the client compares it with its own (RFC 6749 §4.1.2).
		state: String(params.state ?? ''),
		resource: String(params.resource ?? '')
	};
	let error: OAuthError | undefined;
	if (params.response_type !== 'code') {
		error = new OAuthError('unsupported_response_type', 'Only the code flow is supported.');
	} else if (
		params.code_challenge_method !== 'S256' ||
		!/^[A-Za-z0-9_-]{43}$/.test(request.codeChallenge)
	) {
		error = new OAuthError('invalid_request', 'PKCE with S256 is required.');
	} else if (request.resource && request.resource !== resourceUrl) {
		error = new OAuthError('invalid_target', 'This server only issues tokens for its own address.');
	}
	return { request, client, error };
}

/** The redirect address with these answers added to its query. */
export function withQuery(uri: string, params: Record<string, string>): string {
	const url = new URL(uri);
	for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
	return url.href;
}

/**
 * The person approves on the Hub's consent page (the `claude.approve` action of `coreAction`, so
 * Firebase has verified who they are). Their sign-in must be fresh, their account not revoked
 * since, and their profile must let them connect. Gives a single-use code bound to the client, its
 * redirect address and the PKCE challenge, and returns where to send them.
 */
export async function approve(
	keys: Keys,
	params: Record<string, unknown>,
	signedIn: { uid: string; authTime: number },
	resourceUrl: string
): Promise<{ redirect: string }> {
	const { request, error } = checkAuthorize(keys, params, resourceUrl);
	if (error) {
		return {
			redirect: withQuery(request.redirectUri, { error: error.error, state: request.state })
		};
	}
	if (!signedIn.authTime || Date.now() / 1000 - signedIn.authTime > FRESH_SIGN_IN_SECONDS) {
		throw new HttpsError('failed-precondition', 'Sign in again to approve.');
	}
	// The same gate as every call: an account disabled or revoked since that sign-in, a guest, or
	// someone without the connect permission gets no code.
	await requireCaller(signedIn.uid, signedIn.authTime * 1000, { revoke: false });

	// A code left unused by an earlier try of the same person goes now (at most a handful).
	const old = await codes().where('uid', '==', signedIn.uid).limit(20).get();
	// Signed like the tokens: /token refuses a made-up code before any Firestore read.
	const random = randomId(32);
	const code = `${random}.${hmac(keys.access, `code.${random}`)}`;
	const batch = db.batch();
	old.docs.forEach((d) => batch.delete(d.ref));
	batch.set(codes().doc(sha256(code)), {
		uid: signedIn.uid,
		clientId: request.clientId,
		redirectUri: request.redirectUri,
		codeChallenge: request.codeChallenge,
		authTime: signedIn.authTime,
		expiresAt: new Date(Date.now() + CODE_SECONDS * 1000),
		createdAt: serverTimestamp()
	});
	await batch.commit();
	return { redirect: withQuery(request.redirectUri, { code, state: request.state }) };
}

// -- tokens ----------------------------------------------------------------------------------

export interface TokenAnswer {
	access_token: string;
	token_type: 'Bearer';
	expires_in: number;
	refresh_token: string;
}

interface ConnectionDoc {
	uid: string;
	email: string;
	clientId: string;
	clientName: string;
	sendsTo: string;
	/** When the person signed in to approve (ms): revoking their account after it ends this. */
	grantedAt: number;
	createdAt: FirebaseFirestore.Timestamp;
	endsAt: FirebaseFirestore.Timestamp;
	generation: number;
	refreshEndsAt: FirebaseFirestore.Timestamp;
	/** The connection's own key, sealed: refresh secrets of every generation are made from it. */
	keySealed: string;
	/** The last /token answer, sealed, kept for RETRY_SECONDS. */
	lastAnswer: string | null;
	lastAnswerUntil: FirebaseFirestore.Timestamp | null;
	lastUsedAt: FirebaseFirestore.Timestamp | null;
}

function accessToken(keys: Keys, rowId: string, generation: number, endsAtMs: number): string {
	const exp = Math.min(
		Math.floor(Date.now() / 1000) + ACCESS_TOKEN_SECONDS,
		Math.floor(endsAtMs / 1000)
	);
	const body = `a.${rowId}.${generation}.${exp}`;
	return `${body}.${hmac(keys.access, body)}`;
}

/**
 * `r.<row id>.<generation>.<secret>.<tag>`: the tag, under the server key, refuses a
 * made-up token before any read; the secret, under the row's own key, tells the generations apart.
 */
function refreshToken(keys: Keys, rowId: string, generation: number, secret: string): string {
	const body = `r.${rowId}.${generation}.${secret}`;
	return `${body}.${hmac(keys.access, `refresh-tag.${body}`)}`;
}

function refreshSecret(rowKey: Buffer, rowId: string, generation: number): string {
	return hmac(rowKey, `refresh.${rowId}.${generation}`);
}

function answerFor(
	keys: Keys,
	rowId: string,
	row: Pick<ConnectionDoc, 'keySealed' | 'endsAt'>,
	generation: number
): TokenAnswer {
	const rowKey = unseal(keys, row.keySealed, rowId);
	const access = accessToken(keys, rowId, generation, row.endsAt.toMillis());
	const exp = Number(access.split('.')[3]);
	return {
		access_token: access,
		token_type: 'Bearer',
		expires_in: Math.max(0, exp - Math.floor(Date.now() / 1000)),
		refresh_token: refreshToken(keys, rowId, generation, refreshSecret(rowKey, rowId, generation))
	};
}

/** Exchanges a sign-in code for the connection's first tokens (grant_type=authorization_code). */
export async function exchangeCode(
	keys: Keys,
	body: Record<string, unknown>
): Promise<TokenAnswer> {
	const code = String(body.code ?? '');
	const verifier = String(body.code_verifier ?? '');
	if (!code || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) {
		throw new OAuthError('invalid_request', 'The code and a PKCE verifier are required.');
	}
	// A code this server did not sign costs nothing: refused before the transaction's read.
	const [random, tag = ''] = code.split('.');
	if (!random || !same(tag, hmac(keys.access, `code.${random}`))) {
		throw new OAuthError('invalid_grant', 'That code is not valid.');
	}
	const ref = codes().doc(sha256(code));
	// Read and deleted in one transaction: a code works once, however many calls race for it.
	const saved = await db.runTransaction(async (tx) => {
		const snap = await tx.get(ref);
		if (!snap.exists) return null;
		tx.delete(ref);
		return snap.data() as {
			uid: string;
			clientId: string;
			redirectUri: string;
			codeChallenge: string;
			authTime: number;
			expiresAt: FirebaseFirestore.Timestamp;
		};
	});
	if (
		!saved ||
		saved.expiresAt.toMillis() < Date.now() ||
		saved.clientId !== String(body.client_id ?? '') ||
		saved.redirectUri !== String(body.redirect_uri ?? '') ||
		!same(pkceChallenge(verifier), saved.codeChallenge)
	) {
		throw new OAuthError('invalid_grant', 'That code is not valid.');
	}
	const client = readClient(keys, saved.clientId);
	const caller = await requireCaller(saved.uid, saved.authTime * 1000, { revoke: false }).catch(
		(e: unknown) => {
			throw refused(e)
				? new OAuthError('invalid_grant', 'Your profile does not allow connecting Claude.')
				: tryLater();
		}
	);
	const rowKey = randomId(32);
	const ref2 = connections().doc(randomId(18));
	const now = Date.now();
	const endsAt = new Date(now + CONNECTION_DAYS * 86_400_000);
	const row = {
		uid: saved.uid,
		email: caller.email,
		clientId: saved.clientId,
		clientName: client.name,
		sendsTo: describeRedirect(saved.redirectUri),
		grantedAt: saved.authTime * 1000,
		createdAt: serverTimestamp(),
		endsAt,
		generation: 1,
		refreshEndsAt: new Date(Math.min(now + REFRESH_TOKEN_DAYS * 86_400_000, endsAt.getTime())),
		keySealed: seal(keys, Buffer.from(rowKey, 'base64url'), ref2.id),
		lastAnswer: null,
		lastAnswerUntil: null,
		lastUsedAt: serverTimestamp()
	};
	await ref2.set(row);
	return answerFor(keys, ref2.id, { keySealed: row.keySealed, endsAt: timestampOf(endsAt) }, 1);
}

const timestampOf = (d: Date) =>
	({ toMillis: () => d.getTime() }) as unknown as FirebaseFirestore.Timestamp;

/**
 * Exchanges a refresh token for a new pair (grant_type=refresh_token). Every generation's secret
 * is checked against the connection's own key, so a made-up token changes nothing. The current one
 * rotates; the one just replaced, within RETRY_SECONDS, gets the same answer again (a lost reply);
 * any older real one means a copy is in someone else's hands, and the connection ends.
 */
export async function refresh(keys: Keys, body: Record<string, unknown>): Promise<TokenAnswer> {
	const parts = String(body.refresh_token ?? '').split('.');
	const [kind, rowId, genText, secret, tag] = parts;
	const generation = Number(genText);
	if (
		parts.length !== 5 ||
		kind !== 'r' ||
		!ROW_ID.test(rowId) ||
		!Number.isInteger(generation) ||
		generation < 1 ||
		!secret ||
		!same(tag, hmac(keys.access, `refresh-tag.${kind}.${rowId}.${genText}.${secret}`))
	) {
		throw new OAuthError('invalid_grant', 'Unknown refresh token.');
	}
	// A public client names itself on every refresh (OAuth 2.1): the token is bound to it.
	const clientId = String(body.client_id ?? '');
	if (!clientId) throw new OAuthError('invalid_request', 'client_id is required.');
	const ref = connections().doc(rowId);
	// The gate is checked once, even when the transaction runs again.
	let gated: Caller | null = null;
	const outcome = await db.runTransaction(async (tx) => {
		const snap = await tx.get(ref);
		if (!snap.exists) return { kind: 'unknown' as const };
		const row = snap.data() as ConnectionDoc;
		const rowKey = unseal(keys, row.keySealed, rowId);
		if (!same(secret, refreshSecret(rowKey, rowId, generation))) {
			return { kind: 'unknown' as const };
		}
		if (clientId !== row.clientId) return { kind: 'unknown' as const };
		const now = Date.now();
		if (generation === row.generation) {
			if (row.endsAt.toMillis() <= now || row.refreshEndsAt.toMillis() <= now) {
				tx.delete(ref);
				return { kind: 'ended' as const };
			}
			if (!gated) {
				// A definite refusal ends the person's connections (below); a passing failure ends
				// nothing and is thrown on, so this transaction writes nothing.
				let thisOnly = false;
				gated = await requireCaller(row.uid, row.grantedAt, { revoke: false }).catch(
					(e: unknown) => {
						if (!refused(e)) throw tryLater();
						thisOnly = onlyThisConnection(e);
						return null;
					}
				);
				if (!gated && thisOnly) {
					// A sign-in revoked after this connection was approved: this connection ends, the
					// person's newer ones stay.
					tx.delete(ref);
					return { kind: 'revoked' as const };
				}
				if (!gated) return { kind: 'gate' as const, uid: row.uid };
			}
			const next = generation + 1;
			const answer = answerFor(keys, rowId, row, next);
			tx.update(ref, {
				generation: next,
				refreshEndsAt: new Date(
					Math.min(now + REFRESH_TOKEN_DAYS * 86_400_000, row.endsAt.toMillis())
				),
				lastAnswer: seal(keys, JSON.stringify(answer), rowId),
				lastAnswerUntil: new Date(now + RETRY_SECONDS * 1000),
				lastUsedAt: serverTimestamp()
			});
			return { kind: 'ok' as const, answer };
		}
		if (
			generation === row.generation - 1 &&
			row.lastAnswer &&
			row.lastAnswerUntil &&
			row.lastAnswerUntil.toMillis() > now
		) {
			return {
				kind: 'ok' as const,
				answer: JSON.parse(unseal(keys, row.lastAnswer, rowId).toString()) as TokenAnswer
			};
		}
		// A real token of an earlier generation, outside the retry window: a copy is loose.
		tx.delete(ref);
		return { kind: 'reused' as const };
	});
	if (outcome.kind === 'ok') return outcome.answer;
	if (outcome.kind === 'revoked') {
		throw new OAuthError('invalid_grant', 'Your Hub sign-in was revoked. Connect again.');
	}
	if (outcome.kind === 'gate') {
		// The person may no longer connect at all: every connection of theirs ends.
		await revokeAll(outcome.uid);
		throw new OAuthError('invalid_grant', 'Your profile no longer allows connecting Claude.');
	}
	throw new OAuthError(
		'invalid_grant',
		outcome.kind === 'ended'
			? 'This connection has ended. Connect again.'
			: 'Unknown refresh token.'
	);
}

/**
 * The connection an access token belongs to, or null. The tag is checked before any read, so a
 * made-up token costs nothing; then one direct read of the row (a Disconnect or revoke deletes it).
 */
export async function connectionOf(
	keys: Keys,
	token: string
): Promise<{ id: string; uid: string; grantedAt: number; clientName: string } | null> {
	const parts = token.split('.');
	if (parts.length !== 5 || parts[0] !== 'a') return null;
	const [, rowId, genText, expText, tag] = parts;
	if (!same(tag, hmac(keys.access, `a.${rowId}.${genText}.${expText}`))) return null;
	if (Number(expText) * 1000 <= Date.now()) return null;
	const snap = await connections().doc(rowId).get();
	if (!snap.exists) return null;
	const row = snap.data() as ConnectionDoc;
	if (row.endsAt.toMillis() <= Date.now() || Number(genText) > row.generation) return null;
	return { id: rowId, uid: row.uid, grantedAt: row.grantedAt, clientName: row.clientName };
}

// -- the person's and the admins' lists --------------------------------------------------------

function rowOut(doc: FirebaseFirestore.QueryDocumentSnapshot) {
	const d = doc.data() as ConnectionDoc;
	const iso = (t: FirebaseFirestore.Timestamp | null | undefined) =>
		t?.toDate?.().toISOString() ?? null;
	return {
		id: doc.id,
		uid: d.uid,
		email: d.email,
		clientName: d.clientName,
		sendsTo: d.sendsTo,
		createdAt: iso(d.createdAt),
		endsAt: iso(d.endsAt),
		lastUsedAt: iso(d.lastUsedAt)
	};
}

/** Shown on Connected apps; `more` says the person has others the page does not list. */
const OWN_LISTED = 50;
/** Shown on the admins' list, newest first; `more` says there are older ones. */
const ALL_LISTED = 500;

/** The person's own connections (Connected apps). A query on `uid`, with its index. */
export async function listOwn(uid: string) {
	const snap = await connections()
		.where('uid', '==', uid)
		.limit(OWN_LISTED + 1)
		.get();
	return { rows: snap.docs.slice(0, OWN_LISTED).map(rowOut), more: snap.size > OWN_LISTED };
}

/** Every connection, newest first, for the admins' list. */
export async function listAll() {
	const snap = await connections()
		.orderBy('createdAt', 'desc')
		.limit(ALL_LISTED + 1)
		.get();
	return { rows: snap.docs.slice(0, ALL_LISTED).map(rowOut), more: snap.size > ALL_LISTED };
}

/** Ends one connection: its owner (Disconnect) or an admin (revoke). */
export async function endConnection(id: unknown, by: { uid: string; admin: boolean }) {
	const rowId = String(id ?? '');
	if (!/^[A-Za-z0-9_-]{10,64}$/.test(rowId)) {
		throw new HttpsError('invalid-argument', 'Unknown connection.');
	}
	const ref = connections().doc(rowId);
	const snap = await ref.get();
	if (!snap.exists || (!by.admin && snap.data()?.uid !== by.uid)) {
		throw new HttpsError('not-found', 'That connection no longer exists.');
	}
	await ref.delete();
	return { success: true as const };
}

/** An admin ends every connection of one person. */
export async function endAllOf(uid: unknown) {
	return { ended: await revokeAll(String(uid ?? '')) };
}
