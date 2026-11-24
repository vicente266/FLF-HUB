import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpsError } from 'firebase-functions/v2/https';
import { SITE_URL, REGION } from '../../env';
import { createLogger } from '../utils';
import { MCP_SERVER_NAME } from './config';
import { countCall, endConnection, onlyThisConnection, requireCaller } from './caller';
import type { Keys } from './crypto';
import {
	OAuthError,
	checkAuthorize,
	connectionOf,
	exchangeCode,
	refresh,
	registerClient,
	tryLater,
	withQuery
} from './oauth';

/**
 * The connector's one HTTPS endpoint (`claudeMcp`): the OAuth routes, the two discovery documents
 * and MCP itself over streamable HTTP, stateless (docs/claude-connector.md, "How it is built").
 */

const logger = createLogger('claude-connector');

/** The parts of an Express request this needs (firebase-functions passes one, body parsed). */
export type Request = IncomingMessage & {
	path: string;
	originalUrl?: string;
	query: Record<string, unknown>;
	body?: unknown;
};
export type Response = ServerResponse & {
	status(code: number): Response;
	json(body: unknown): void;
	send(body: string): void;
	redirect(status: number, url: string): void;
	set(field: string, value: string): Response;
};

/**
 * This server's own address, from the request: the Cloud Run service's host (where the root paths
 * are its own), or the emulator's prefixed path. Only `Host` is trusted, never X-Forwarded-Host.
 */
export function baseUrl(req: Request): string {
	const host = String(req.headers.host ?? '');
	const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
	return `${local ? 'http' : 'https'}://${host}${emulatorPrefix()}`;
}

/**
 * The functions emulator serves a function under `/<project>/<region>/<name>` and hands it the path
 * without that prefix, so the address must put it back. In production the function has its own
 * Cloud Run host, at the root. `FUNCTION_TARGET` is set by the emulator for the function it runs.
 */
function emulatorPrefix(): string {
	const { FUNCTIONS_EMULATOR, FUNCTION_TARGET, GCLOUD_PROJECT } = process.env;
	if (FUNCTIONS_EMULATOR !== 'true' || !FUNCTION_TARGET || !GCLOUD_PROJECT) return '';
	return `/${GCLOUD_PROJECT}/${REGION}/${FUNCTION_TARGET}`;
}

/**
 * The Hub that shows the consent page: production's, or on the emulator a local one
 * (`FLF_HUB_URL` in functions/.env.local, else `npm run emulate`'s port), never production's.
 */
function hubUrl(): string {
	if (process.env.FUNCTIONS_EMULATOR !== 'true') return SITE_URL;
	return process.env.FLF_HUB_URL || 'http://localhost:5002';
}

function resourceMetadata(base: string) {
	return {
		resource: `${base}/mcp`,
		authorization_servers: [base],
		bearer_methods_supported: ['header'],
		resource_name: MCP_SERVER_NAME,
		resource_documentation: `${SITE_URL}/claude`
	};
}

function serverMetadata(base: string) {
	return {
		issuer: base,
		authorization_endpoint: `${base}/authorize`,
		token_endpoint: `${base}/token`,
		registration_endpoint: `${base}/register`,
		response_types_supported: ['code'],
		response_modes_supported: ['query'],
		grant_types_supported: ['authorization_code', 'refresh_token'],
		code_challenge_methods_supported: ['S256'],
		token_endpoint_auth_methods_supported: ['none'],
		scopes_supported: [],
		client_id_metadata_document_supported: false
	};
}

function oauthError(res: Response, e: OAuthError) {
	res.status(e.status).set('Cache-Control', 'no-store').json({
		error: e.error,
		error_description: e.description
	});
}

/**
 * A 401 with where to sign in. A request that sent no token gets no error code (RFC 6750 §3.1):
 * it is a first contact, not a bad token.
 */
function unauthorized(res: Response, base: string, error: string | null = 'invalid_token') {
	const metadata = `resource_metadata="${base}/.well-known/oauth-protected-resource"`;
	res
		.status(401)
		.set('WWW-Authenticate', error ? `Bearer error="${error}", ${metadata}` : `Bearer ${metadata}`)
		.json(
			error
				? { error, error_description: 'Sign in to the FLF Hub again.' }
				: { error_description: 'Sign in to the FLF Hub.' }
		);
}

/** A JSON-RPC "try again" answer: a passing failure, the rate limit. */
function retryLater(res: Response, status: 429 | 503, message: string) {
	res
		.status(status)
		.set('Retry-After', status === 429 ? '60' : '5')
		.json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

/** An OAuth body: form-encoded per RFC 6749, or JSON from a lenient client. */
function bodyOf(req: Request): Record<string, unknown> {
	const body = req.body;
	if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
		return body as Record<string, unknown>;
	}
	if (typeof body === 'string' || Buffer.isBuffer(body)) {
		const text = body.toString();
		try {
			const parsed: unknown = JSON.parse(text);
			return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
		} catch {
			return Object.fromEntries(new URLSearchParams(text));
		}
	}
	return {};
}

/** Answers one request. `keys` come from the `FLF_MCP_KEY` secret. */
export async function handle(req: Request, res: Response, keys: Keys): Promise<void> {
	const base = baseUrl(req);
	const path = (req.path || '/').replace(/\/+$/, '') || '/';
	res.set('X-Content-Type-Options', 'nosniff');

	try {
		// Discovery: at the root (RFC 8414 / 9728 on the service's own host), with the resource or
		// issuer path inserted after it, or appended to it, as clients try each. Public documents,
		// readable by an MCP client in a browser too (CORS, preflight included).
		if (/\/\.well-known\//.test(path)) {
			res.set('Access-Control-Allow-Origin', '*');
			if (req.method === 'OPTIONS') {
				// The MCP SDK asks with its protocol version header, which the preflight must allow.
				res
					.set('Access-Control-Allow-Methods', 'GET')
					.set('Access-Control-Allow-Headers', 'MCP-Protocol-Version')
					.set('Access-Control-Max-Age', '86400');
				res.status(204).end();
				return;
			}
		}
		if (req.method === 'GET' && /\/\.well-known\/oauth-protected-resource(\/.*)?$/.test(path)) {
			res.json(resourceMetadata(base));
			return;
		}
		if (
			req.method === 'GET' &&
			/\/\.well-known\/(oauth-authorization-server|openid-configuration)(\/.*)?$/.test(path)
		) {
			res.json(serverMetadata(base));
			return;
		}

		if (path === '/register' && req.method === 'POST') {
			res
				.status(201)
				.set('Cache-Control', 'no-store')
				.json(registerClient(keys, bodyOf(req)));
			return;
		}

		if (path === '/authorize' && req.method === 'GET') {
			let checked;
			try {
				checked = checkAuthorize(keys, req.query, `${base}/mcp`);
			} catch (e) {
				// The client or its redirect can't be trusted: say so here, never redirect there.
				const why = e instanceof OAuthError ? e.description : 'This sign-in link is not valid.';
				res.status(400).set('Content-Type', 'text/plain; charset=utf-8').send(`FLF Hub: ${why}`);
				return;
			}
			const { request, error } = checked;
			if (error) {
				res.redirect(
					302,
					withQuery(request.redirectUri, { error: error.error, state: request.state })
				);
				return;
			}
			// The Hub's consent page signs the person in and asks them to approve (`claude.approve`).
			const consent = new URL(`${hubUrl()}/claude/connect`);
			for (const k of [
				'client_id',
				'redirect_uri',
				'response_type',
				'code_challenge',
				'code_challenge_method',
				'state',
				'resource'
			]) {
				const v = req.query[k];
				if (typeof v === 'string' && v) consent.searchParams.set(k, v);
			}
			consent.searchParams.set('server', base);
			res.redirect(302, consent.href);
			return;
		}

		if (path === '/token' && req.method === 'POST') {
			const body = { ...bodyOf(req) };
			// A client that registered asking for client_secret_basic (registered as public, `none`)
			// may still send its id in a Basic header: the id is taken from there, any secret ignored.
			const basic = /^Basic\s+(.+)$/i.exec(String(req.headers.authorization ?? ''));
			if (basic && !body.client_id) {
				const pair = Buffer.from(basic[1], 'base64').toString('utf8');
				try {
					const id = decodeURIComponent(pair.split(':')[0] ?? '');
					if (id) body.client_id = id;
				} catch {
					// A malformed header names no client: the request is refused as having none.
				}
			}
			let answer;
			try {
				if (body.grant_type === 'authorization_code') answer = await exchangeCode(keys, body);
				else if (body.grant_type === 'refresh_token') answer = await refresh(keys, body);
				else {
					throw new OAuthError(
						'unsupported_grant_type',
						'Use authorization_code or refresh_token.'
					);
				}
			} catch (e) {
				// Firestore failing for a moment is "try again", never "sign in again".
				if (e instanceof OAuthError) throw e;
				logger.error('mcp token request failed', e);
				throw tryLater();
			}
			res.set('Cache-Control', 'no-store').set('Pragma', 'no-cache').json(answer);
			return;
		}

		if (path === '/mcp' || path === '/') {
			if (req.method !== 'POST') {
				// Stateless: no session to stream or end.
				res
					.status(405)
					.set('Allow', 'POST')
					.json({
						jsonrpc: '2.0',
						error: { code: -32000, message: 'Method not allowed.' },
						id: null
					});
				return;
			}
			// One JSON-RPC message per request. A batch (up to 100 in the SDK) would count as one call
			// against the rate limit. MCP's own clients send none (batching left the spec in 2025-06-18).
			if (Array.isArray(req.body)) {
				res.status(400).json({
					jsonrpc: '2.0',
					error: {
						code: -32600,
						message: 'Batches are not supported: send one message per request.'
					},
					id: null
				});
				return;
			}
			const header = String(req.headers.authorization ?? '');
			const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
			let connection;
			try {
				connection = token ? await connectionOf(keys, token) : null;
			} catch (e) {
				logger.error('mcp connection read failed', e);
				retryLater(res, 503, 'Try again in a moment.');
				return;
			}
			if (!connection) {
				unauthorized(res, base, token ? 'invalid_token' : null);
				return;
			}
			let caller;
			try {
				// Every call: the account, the role and the groups read fresh. A definite refusal ends
				// every connection of theirs (caller.ts); a passing failure ends nothing.
				// The rate limit first: a flood of calls is turned away before each reads the account,
				// the role and the groups.
				await countCall(connection.uid);
				caller = await requireCaller(connection.uid, connection.grantedAt);
			} catch (e) {
				const code = e instanceof HttpsError ? e.code : 'unavailable';
				const message = e instanceof HttpsError ? e.message : 'Try again in a moment.';
				logger.warn(`mcp refused uid=${connection.uid}: ${code}`);
				if (code === 'permission-denied') {
					// A sign-in revoked after this connection was approved ends this connection only.
					if (onlyThisConnection(e)) await endConnection(connection.id);
					unauthorized(res, base);
					return;
				}
				retryLater(res, code === 'resource-exhausted' ? 429 : 503, message);
				return;
			}
			// A new server and transport for this request only (the SDK's stateless mode): the caller
			// lives in that server's closure, never in module state shared by two people's calls.
			// Loaded on the first call, so the Hub's other functions never load the SDK.
			const { serve } = await import('./tools.js');
			await serve(caller, req, res);
			return;
		}

		res.status(404).json({ error: 'not_found' });
	} catch (e) {
		if (e instanceof OAuthError) {
			oauthError(res, e);
			return;
		}
		logger.error('mcp request failed', e);
		if (!res.headersSent) res.status(500).json({ error: 'server_error' });
	}
}
