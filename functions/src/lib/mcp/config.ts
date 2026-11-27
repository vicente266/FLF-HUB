/**
 * The FLF Hub connector for Claude (docs/claude-connector.md): its collections, lifetimes and
 * limits. Ported from the EBS Hub's My Work connector. None of its collections has a rule in
 * firestore.rules, so the browser can read none of them.
 */

/** One row per connection (a person approving one Claude client). Keyed by a random id. */
export const CONNECTION_COLLECTION = 'mcpConnection';
/** Sign-in codes, single use, about a minute. */
export const CODE_COLLECTION = 'mcpCode';
/** One rate-limit counter per person. */
export const LIMIT_COLLECTION = 'mcpLimit';
/** One doc per read tool call: who, which tool, which ids, when. Never content. */
export const AUDIT_COLLECTION = 'mcpAudit';

/** The permission that lets a person connect Claude at all. No admin bypass. */
export const CONNECT_PERMISSION = 'claude.self.connect';

export const ACCESS_TOKEN_SECONDS = 60 * 60;
export const REFRESH_TOKEN_DAYS = 30;
/** A connection ends this long after it was approved, however often it is used. */
export const CONNECTION_DAYS = 90;
export const CODE_SECONDS = 60;
/** The token just replaced, sent again within this window, gets the same answer (a lost reply). */
export const RETRY_SECONDS = 120;
/** The consent page's sign-in must be this fresh. */
export const FRESH_SIGN_IN_SECONDS = 5 * 60;

/** Calls a minute per person. */
export const RATE_PER_MINUTE = 60;
/** Read audit docs are kept a year, deleted by the nightly job. */
export const AUDIT_KEEP_DAYS = 365;
/** How long the nightly clean-up may delete; what is left goes the next night. */
export const CLEANUP_SECONDS = 180;

/** At most this many records a list tool returns in one page. */
export const LIST_LIMIT = 50;
/** At most this many timeline entries `flf_get_contact` returns. */
export const THREAD_LIMIT = 30;
/** Contacts a search scans before filtering in code (newest first). */
export const SCAN_LIMIT = 500;

/** Where claude.ai sends a person back after they approve. Anything else but loopback is refused. */
export const CALLBACKS = [
	'https://claude.ai/api/mcp/auth_callback',
	'https://claude.com/api/mcp/auth_callback'
];

export const MCP_SERVER_NAME = 'FLF Hub';

/**
 * The connector's address, for the Hub's Claude page: what people paste into claude.ai (Add custom
 * connector) or Claude Code. The `claudeMcp` function gets its own Cloud Run host at the first
 * deploy; put it in `functions/.env.flfhub` (committed) as FLF_CONNECTOR_URL (`https://<host>/mcp`). The server itself
 * answers on whatever host it is reached at.
 */
export const CONNECTOR_URL = process.env.FLF_CONNECTOR_URL ?? '';
