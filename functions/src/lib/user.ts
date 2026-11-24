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
	const role: UserRole =
		auth.token.role === 'admin' ? 'admin' : TEAM_DOMAINS.includes(domain) ? 'user' : 'guest';

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

export async function hasPermission(uid: string, permission: string): Promise<boolean> {
	const doc = await collection.doc(uid).get();
	const data = doc.data() as User | undefined;
	if (!data || data.role === 'guest') return false;
	return (await permissionsOf(data.groups ?? [])).includes(permission);
}

/** What an admin controls about a user. The `syncUserRole` trigger mirrors the role into claims. */
export async function updateAccess(
	uid: string,
	role: UserRole,
	groups: string[],
	sherpa: boolean
): Promise<void> {
	await collection.doc(uid).update({ role, groups, sherpa, updatedAt: serverTimestamp() });
}

/** Signed-in team members who are Sherpas, for assignment. */
export async function sherpas(): Promise<{ uid: string; email: string; name: string }[]> {
	const snap = await collection.where('sherpa', '==', true).get();
	return snap.docs
		.filter((d) => d.data().role !== 'guest')
		.map((d) => ({ uid: d.id, email: d.data().email, name: d.data().name ?? '' }));
}
