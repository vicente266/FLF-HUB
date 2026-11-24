import admin from 'firebase-admin';
import { HttpsError } from 'firebase-functions/v2/https';
import { db } from '../../firestore';
import * as user from '../user';
import {
	AUDIT_COLLECTION,
	AUDIT_KEEP_DAYS,
	CLEANUP_SECONDS,
	CODE_COLLECTION,
	CONNECT_PERMISSION,
	CONNECTION_COLLECTION,
	LIMIT_COLLECTION,
	RATE_PER_MINUTE
} from './config';

/** The signed-in shape every action receives (`auth.uid`, `auth.token.role`). */
export interface CallerAuth {
	uid: string;
	token: { uid: string; email: string; name: string; role: string };
}

/** The person a connector call runs as, read fresh from their account, user doc and groups. */
export interface Caller {
	uid: string;
	email: string;
	/** From the user doc, never the custom claims (which a trigger writes later). */
	role: string;
	permissions: string[];
	/** Shaped as `dispatch` passes it to every action, with the role the gate checked. */
	auth: CallerAuth;
}

/**
 * Builds the caller, or refuses with `permission-denied` (and, unless told not to, ends every
 * connection of theirs) on a definite answer, when:
 * the Firebase account is disabled; it was revoked after `grantedAtMs` (this one ends nothing here:
 * it is about one connection, see `onlyThisConnection`); the person is a guest or
 * has no user doc; their groups don't grant `claude.self.connect` (admins too: no bypass). Anything else that fails (Auth or Firestore unreachable) is thrown as it
 * is, or as `unavailable`, and ends nothing.
 *
 * Cost: 1 Auth call, 1 read of the user doc, 1 read per group.
 */
export async function requireCaller(
	uid: string,
	grantedAtMs: number,
	{ revoke = true }: { revoke?: boolean } = {}
): Promise<Caller> {
	const refuse = async (why: string): Promise<never> => {
		if (revoke) await revokeAll(uid);
		throw new HttpsError('permission-denied', why);
	};
	let account: admin.auth.UserRecord;
	try {
		account = await admin.auth().getUser(uid);
	} catch (e) {
		// Only a definite "no such account" refuses (and ends connections). An outage, a quota or a
		// timeout is passing: the caller gets "try again", and nothing is ended.
		if ((e as { code?: string })?.code === 'auth/user-not-found') {
			return refuse('This Hub account no longer exists.');
		}
		throw new HttpsError('unavailable', 'Try again in a moment.');
	}
	if (account.disabled) return refuse('This Hub account is disabled.');
	const validAfter = account.tokensValidAfterTime ? Date.parse(account.tokensValidAfterTime) : 0;
	// Strictly later, as Firebase's own revocation check: a revocation in the same second as the
	// sign-in does not count (both are kept to the second).
	if (validAfter && validAfter > grantedAtMs) {
		// About this connection only (approved before the revocation): a connection approved after
		// it passes the same check, so the caller ends just this row, not all of the person's.
		throw new HttpsError('permission-denied', 'Your Hub sign-in was revoked. Connect again.', {
			scope: 'connection'
		});
	}
	const snap = await user.collection.doc(uid).get();
	const data = snap.data() as user.User | undefined;
	if (!snap.exists || !data || data.role === 'guest')
		return refuse('Guests cannot use the FLF Hub.');
	const granted = await user.permissionsOf(data.groups ?? []);
	if (!granted.includes(CONNECT_PERMISSION)) {
		return refuse('Your Hub profile does not include Claude access yet. Ask an admin.');
	}
	const email = String(data.email ?? account.email ?? '');
	const role = data.role ?? 'user';
	const name = data.name || account.displayName || email;
	const auth: CallerAuth = { uid, token: { uid, email, name, role } };
	return { uid, email, role, permissions: granted, auth };
}

/** Whether a `requireCaller` refusal ends only the connection that called (revoked sign-in). */
export function onlyThisConnection(e: unknown): boolean {
	return (
		e instanceof HttpsError && (e.details as { scope?: string } | undefined)?.scope === 'connection'
	);
}

/** Ends one connection (its row). One delete. */
export async function endConnection(rowId: string): Promise<void> {
	if (rowId) await db.collection(CONNECTION_COLLECTION).doc(rowId).delete();
}

/**
 * Ends every connection of a person: a query on `uid`, with its index, 100 at a time until none
 * is left, so a person with more never keeps the rest.
 */
export async function revokeAll(uid: string): Promise<number> {
	if (!uid) return 0;
	let ended = 0;
	for (;;) {
		const snap = await db
			.collection(CONNECTION_COLLECTION)
			.where('uid', '==', uid)
			.limit(100)
			.get();
		if (snap.empty) return ended;
		const batch = db.batch();
		snap.docs.forEach((d) => batch.delete(d.ref));
		await batch.commit();
		ended += snap.size;
	}
}

/**
 * Counts a call against the person's minute: one counter doc each, read and written in one
 * transaction (instances share no memory). Refused past RATE_PER_MINUTE; a burst that exhausts
 * Firestore's retries is answered "busy".
 */
export async function countCall(uid: string): Promise<void> {
	const ref = db.collection(LIMIT_COLLECTION).doc(uid);
	let allowed: boolean;
	try {
		allowed = await db.runTransaction(async (tx) => {
			const now = Date.now();
			const d = (await tx.get(ref)).data() as { windowStart?: number; count?: number } | undefined;
			if (!d || !d.windowStart || now - d.windowStart >= 60_000) {
				tx.set(ref, { windowStart: now, count: 1 });
				return true;
			}
			if ((d.count ?? 0) >= RATE_PER_MINUTE) return false;
			tx.update(ref, { count: (d.count ?? 0) + 1 });
			return true;
		});
	} catch {
		throw new HttpsError('resource-exhausted', 'Busy, try again in a moment.');
	}
	if (!allowed) {
		throw new HttpsError(
			'resource-exhausted',
			`More than ${RATE_PER_MINUTE} calls in a minute. Wait a minute and try again.`
		);
	}
}

/** One audit doc for a read tool call: who, which tool, which ids, when. Never any content. */
export async function audit(caller: { uid: string }, tool: string, ids: string[]): Promise<void> {
	await db.collection(AUDIT_COLLECTION).add({
		uid: caller.uid,
		tool,
		ids: [...new Set(ids)].slice(0, 200),
		at: new Date()
	});
}

/**
 * The nightly clean-up: read audit docs past a year, sign-in codes past their minute, and
 * connections past their end. Each a query on its date field, with its index.
 */
export async function cleanUp(): Promise<{
	audit: number;
	codes: number;
	connections: number;
	unfinished: string[];
}> {
	const now = new Date();
	const deadline = Date.now() + CLEANUP_SECONDS * 1000;
	const unfinished: string[] = [];
	const sweep = async (collection: string, field: string, before: Date) => {
		let removed = 0;
		for (;;) {
			if (Date.now() > deadline) {
				unfinished.push(collection);
				break;
			}
			const snap = await db.collection(collection).where(field, '<', before).limit(400).get();
			if (snap.empty) break;
			const batch = db.batch();
			snap.docs.forEach((d) => batch.delete(d.ref));
			await batch.commit();
			removed += snap.size;
			if (snap.size < 400) break;
		}
		return removed;
	};
	return {
		audit: await sweep(
			AUDIT_COLLECTION,
			'at',
			new Date(now.getTime() - AUDIT_KEEP_DAYS * 86_400_000)
		),
		codes: await sweep(CODE_COLLECTION, 'expiresAt', now),
		connections: await sweep(CONNECTION_COLLECTION, 'endsAt', now),
		unfinished
	};
}
