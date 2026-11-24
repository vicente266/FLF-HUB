/** One Claude connection, as `core:claude.connections` and `core:claude.admin.list` return it. */
export interface ClaudeConnection {
	id: string;
	uid: string;
	email: string;
	clientName: string;
	sendsTo: string;
	createdAt: string | null;
	endsAt: string | null;
	lastUsedAt: string | null;
}
