import { db } from '../firestore';
import { PERMISSIONS } from './permissions';

export const collection = db.collection('group');

/** The group every new user is put in. */
export const DEFAULT_NAME = 'Default';

export interface Group {
	name: string;
	description?: string;
	permissions: string[];
}

/** Create or update a group, names unique case-insensitively. Returns its id. */
export async function save(
	id: string | null,
	name: string,
	description: string,
	permissions: string[]
): Promise<string> {
	const trimmed = name.trim();
	if (!trimmed) throw new Error('A group needs a name.');
	const clean = [...new Set(permissions)].filter((p) =>
		(PERMISSIONS as readonly string[]).includes(p)
	);

	const all = await collection.get();
	const duplicate = all.docs.find(
		(d) => String(d.data().name).toLowerCase() === trimmed.toLowerCase() && d.id !== id
	);
	if (duplicate) throw new Error(`A group named "${duplicate.data().name}" already exists.`);

	const data = { name: trimmed, description: description.trim(), permissions: clean };
	if (id) {
		await collection.doc(id).update(data);
		return id;
	}
	return (await collection.add(data)).id;
}

/** Delete a group and remove it from every user in it. The Default group cannot be deleted. */
export async function remove(id: string): Promise<void> {
	const doc = await collection.doc(id).get();
	if (doc.data()?.name === DEFAULT_NAME) throw new Error('The Default group cannot be deleted.');
	await collection.doc(id).delete();
	const users = await db.collection('user').where('groups', 'array-contains', id).get();
	const batch = db.batch();
	users.forEach((u) =>
		batch.update(u.ref, { groups: (u.data().groups as string[]).filter((g) => g !== id) })
	);
	await batch.commit();
}
