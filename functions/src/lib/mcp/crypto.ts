import * as crypto from 'node:crypto';

/**
 * The connector's keys, all derived from one secret in Secret Manager (`FLF_MCP_KEY`), one
 * per purpose, and each value signed under a key starts with its own prefix (`code.`,
 * `refresh-tag.`…), so a value signed for one purpose never checks as another.
 */
export interface Keys {
	/** Signs a registered client's id, which carries its name and redirect addresses. */
	client: Buffer;
	/** Signs access tokens, sign-in codes and refresh tokens' tags. */
	access: Buffer;
	/** Encrypts each connection's own key and its last token answer (AES-256-GCM). */
	seal: Buffer;
}

const PURPOSES = ['client', 'access', 'seal'] as const;

/** The keys, from the secret's value. Refuses a short or missing secret: no default key. */
export function keysFrom(secret: string): Keys {
	if (!secret || secret.length < 32) {
		throw new Error('FLF_MCP_KEY is missing or shorter than 32 characters.');
	}
	const out = {} as Record<(typeof PURPOSES)[number], Buffer>;
	for (const purpose of PURPOSES) {
		out[purpose] = Buffer.from(
			crypto.hkdfSync('sha256', secret, 'flf-hub-mcp', `flf-mcp:${purpose}`, 32)
		);
	}
	return out;
}

export const b64url = (buf: Buffer) => buf.toString('base64url');

export function randomId(bytes = 24): string {
	return b64url(crypto.randomBytes(bytes));
}

export function hmac(key: Buffer, data: string): string {
	return b64url(crypto.createHmac('sha256', key).update(data).digest());
}

export function sha256(data: string): string {
	return b64url(crypto.createHash('sha256').update(data).digest());
}

/** Equal strings, compared in constant time. */
export function same(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Encrypts a value under the seal key: iv.tag.ciphertext, base64url. `boundTo` (the connection's
 * row id) is authenticated with it, so a value copied onto another row never decrypts there.
 */
export function seal(keys: Keys, plain: string | Buffer, boundTo: string): string {
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv('aes-256-gcm', keys.seal, iv);
	cipher.setAAD(Buffer.from(`flf-mcp-row:${boundTo}`));
	const body = Buffer.concat([cipher.update(plain), cipher.final()]);
	return [iv, cipher.getAuthTag(), body].map(b64url).join('.');
}

/** Decrypts `seal`'s output for the same row; throws on anything altered or on another row. */
export function unseal(keys: Keys, sealed: string, boundTo: string): Buffer {
	const [iv, tag, body] = sealed.split('.').map((p) => Buffer.from(p ?? '', 'base64url'));
	const decipher = crypto.createDecipheriv('aes-256-gcm', keys.seal, iv);
	decipher.setAAD(Buffer.from(`flf-mcp-row:${boundTo}`));
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** PKCE S256: the challenge a verifier makes. */
export function pkceChallenge(verifier: string): string {
	return b64url(crypto.createHash('sha256').update(verifier).digest());
}
