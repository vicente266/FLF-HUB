import admin from 'firebase-admin';
import { HttpsError } from 'firebase-functions/v2/https';
import { db } from '../firestore';
import * as group from './group';
import { serverTimestamp } from './utils';

export const collection = db.collection('user');

export type UserRole = 'guest' | 'user' | 'admin';

/**
 * Email domains whose accounts start as `user` instead of `guest`. Anyone else waits for an
 * admin. Empty until FLF decides which domain the team signs in with.
 */
export const TEAM_DOMAINS: string[] = ['foundersforlifefellowship.com'];

export interface User {
	email: string;
	name?: string;
	role: UserRole;
	groups: string[];
	/** Sherpas receive new contacts from the assignment automation. */
	sherpa?: boolean;
	createdAt: FirebaseFirestore.Timestamp;
	updatedAt: FirebaseFirestore.Timestamp;
}

/** The user's document, created on first sign-in (role from the email domain, Default group). */
export async function getOrCreate(auth: any): Promise<User> {
	const ref = collection.doc(auth.uid);
	const doc = await ref.get();
	if (doc.exists) return doc.data() as User;

	const email = String(auth.token.email ?? '').toLowerCase();
	const domain = email.split('@')[1] ?? '';
	// The team's domain counts only for a Google sign-in whose email Google has verified.
	const provenTeam =
		TEAM_DOMAINS.includes(domain) &&
		auth.token.email_verified === true &&
		auth.token.firebase?.sign_in_provider === 'google.com';
	let role: UserRole = 'guest';
	if (auth.token.role === 'admin') role = 'admin';
	else if (provenTeam) role = 'user';

	const def = await group.collection.where('name', '==', group.DEFAULT_NAME).limit(1).get();
	const data = {
		email,
		name: auth.token.name ?? '',
		role,
		groups: def.empty ? [] : [def.docs[0].id],
		sherpa: false,
		createdAt: serverTimestamp(),
		updatedAt: serverTimestamp()
	};
	await ref.set(data);
	return (await ref.get()).data() as User;
}

/** Union of the permissions of every group the user is in. */
export async function permissionsOf(groups: string[]): Promise<string[]> {
	if (!groups.length) return [];
	const refs = groups.map((id) => group.collection.doc(id));
	const docs = await db.getAll(...refs);
	return [...new Set(docs.flatMap((d) => (d.data()?.permissions as string[]) ?? []))];
}

/** The role stored on the user doc (the token's claim can be up to an hour old). */
export async function roleOf(uid: string): Promise<UserRole | null> {
	const data = (await collection.doc(uid).get()).data() as User | undefined;
	return data?.role ?? null;
}

export async function hasPermission(uid: string, permission: string): Promise<boolean> {
	const doc = await collection.doc(uid).get();
	const data = doc.data() as User | undefined;
	if (!data || data.role === 'guest') return false;
	return (await permissionsOf(data.groups ?? [])).includes(permission);
}

/**
 * What an admin controls about a user. The `syncUserRole` trigger mirrors the role into claims.
 * The last admin can't be demoted (one count query, only on a demotion): nobody could undo it.
 */
export async function updateAccess(
	uid: string,
	role: UserRole,
	groups: string[],
	sherpa: boolean
): Promise<{ before: UserRole | null }> {
	const before = await roleOf(uid);
	if (before === 'admin' && role !== 'admin') {
		const admins = (await collection.where('role', '==', 'admin').count().get()).data().count;
		if (admins <= 1)
			throw new HttpsError('failed-precondition', 'Make someone else an admin first.');
	}
	await collection.doc(uid).update({ role, groups, sherpa, updatedAt: serverTimestamp() });
	// The claim now, not only through the syncUserRole trigger.
	await admin.auth().setCustomUserClaims(uid, { role });
	return { before };
}
