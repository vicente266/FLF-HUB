import { HttpsError } from 'firebase-functions/v2/https';
import { db } from '../../firestore';
import { serverTimestamp, str, oneOf } from '../utils';
import {
	CONTACT_TYPES,
	PIPELINES,
	SOURCES,
	STALE_DAYS,
	firstStage,
	stageOf,
	type ContactType,
	type Source
} from './config';

export const contacts = db.collection('contact');
export const tasks = db.collection('task');

export interface Contact {
	type: ContactType;
	name: string;
	email: string;
	phone: string;
	company: string;
	linkedin: string;
	source: Source;
	stage: string;
	/** Copied from the stage, so open/closed is one equality filter. */
	open: boolean;
	ownerUid: string | null;
	ownerName: string | null;
	tags: string[];
	notes: string;
	needsAttention: boolean;
	stageChangedAt: FirebaseFirestore.Timestamp;
	lastActivityAt: FirebaseFirestore.Timestamp;
	createdAt: FirebaseFirestore.Timestamp;
	updatedAt: FirebaseFirestore.Timestamp;
	createdBy: string;
}

export type ActivityKind = 'created' | 'note' | 'stage' | 'assigned' | 'automation' | 'updated';

const who = (auth: any) => auth?.token?.name || auth?.token?.email || 'System';

export function config() {
	return { types: CONTACT_TYPES, sources: SOURCES, pipelines: PIPELINES, staleDays: STALE_DAYS };
}

/** Append one entry to a contact's timeline and touch its last activity. */
export async function logActivity(
	contactId: string,
	kind: ActivityKind,
	text: string,
	by: string,
	extra: Record<string, unknown> = {}
): Promise<void> {
	const ref = contacts.doc(contactId);
	const batch = db.batch();
	batch.set(ref.collection('activity').doc(), { kind, text, by, at: serverTimestamp(), ...extra });
	batch.update(ref, { lastActivityAt: serverTimestamp(), needsAttention: false });
	await batch.commit();
}

/** Fields an editor may set on create or update. */
function fields(p: any) {
	return {
		name: str(p.name, 'name'),
		email: str(p.email, 'email', false).toLowerCase(),
		phone: str(p.phone, 'phone', false),
		company: str(p.company, 'company', false),
		linkedin: str(p.linkedin, 'linkedin', false),
		notes: str(p.notes, 'notes', false),
		tags: Array.isArray(p.tags)
			? [...new Set(p.tags.map((t: unknown) => String(t).trim()).filter(Boolean))]
			: []
	};
}

/** The contact with this email, if there is one. */
export async function findByEmail(email: string) {
	if (!email) return null;
	const snap = await contacts.where('email', '==', email.toLowerCase()).limit(1).get();
	return snap.empty ? null : snap.docs[0];
}

export async function create(p: any, by: string, uid: string): Promise<string> {
	const type = oneOf(p.type, CONTACT_TYPES, 'type');
	const source = p.source ? oneOf(p.source, SOURCES, 'source') : 'manual';
	const f = fields(p);
	if (f.email && (await findByEmail(f.email))) {
		throw new HttpsError('already-exists', `A contact with ${f.email} already exists.`);
	}
	const stage = firstStage(type);
	const ref = contacts.doc();
	await ref.set({
		type,
		source,
		...f,
		stage,
		open: true,
		ownerUid: null,
		ownerName: null,
		needsAttention: false,
		stageChangedAt: serverTimestamp(),
		lastActivityAt: serverTimestamp(),
		createdAt: serverTimestamp(),
		updatedAt: serverTimestamp(),
		createdBy: uid
	});
	await ref.collection('activity').add({
		kind: 'created',
		text: `Created from ${source}`,
		by,
		at: serverTimestamp()
	});
	return ref.id;
}

export const actions = {
	'config.get': async () => config(),

	'contact.create': async (p: any, auth: any) => ({ id: await create(p, who(auth), auth.uid) }),

	'contact.update': async (p: any, auth: any) => {
		const id = str(p.id, 'id');
		const f = fields(p);
		if (f.email) {
			const other = await findByEmail(f.email);
			if (other && other.id !== id) {
				throw new HttpsError('already-exists', `Another contact already uses ${f.email}.`);
			}
		}
		await contacts.doc(id).update({ ...f, updatedAt: serverTimestamp() });
		await logActivity(id, 'updated', 'Details updated', who(auth));
		return { ok: true };
	},

	'contact.stage': async (p: any, auth: any) => {
		const id = str(p.id, 'id');
		const doc = await contacts.doc(id).get();
		if (!doc.exists) throw new HttpsError('not-found', 'Contact not found.');
		const c = doc.data() as Contact;
		const stage = stageOf(c.type, str(p.stage, 'stage'));
		if (!stage) throw new HttpsError('invalid-argument', 'Invalid stage.');
		if (stage.id === c.stage) return { ok: true };
		const from = stageOf(c.type, c.stage)?.label ?? c.stage;
		await doc.ref.update({
			stage: stage.id,
			open: !stage.final,
			stageChangedAt: serverTimestamp(),
			updatedAt: serverTimestamp()
		});
		await logActivity(id, 'stage', `${from} → ${stage.label}`, who(auth), {
			from: c.stage,
			to: stage.id
		});
		return { ok: true };
	},

	'contact.assign': async (p: any, auth: any) => {
		const id = str(p.id, 'id');
		const ownerUid = str(p.ownerUid, 'ownerUid', false) || null;
		let ownerName: string | null = null;
		if (ownerUid) {
			const u = await db.collection('user').doc(ownerUid).get();
			if (!u.exists) throw new HttpsError('not-found', 'User not found.');
			ownerName = u.data()?.name || u.data()?.email;
		}
		await contacts.doc(id).update({ ownerUid, ownerName, updatedAt: serverTimestamp() });
		await logActivity(
			id,
			'assigned',
			ownerName ? `Assigned to ${ownerName}` : 'Unassigned',
			who(auth)
		);
		return { ok: true };
	},

	'contact.delete': async (p: any) => {
		const id = str(p.id, 'id');
		await db.recursiveDelete(contacts.doc(id));
		const open = await tasks.where('contactId', '==', id).get();
		const batch = db.batch();
		open.forEach((t) => batch.delete(t.ref));
		await batch.commit();
		return { ok: true };
	},

	'note.add': async (p: any, auth: any) => {
		await logActivity(str(p.id, 'id'), 'note', str(p.text, 'text'), who(auth));
		return { ok: true };
	},

	'task.create': async (p: any, auth: any) => {
		const contactId = str(p.contactId, 'contactId');
		const c = await contacts.doc(contactId).get();
		if (!c.exists) throw new HttpsError('not-found', 'Contact not found.');
		const due = new Date(str(p.dueAt, 'dueAt'));
		if (isNaN(due.getTime())) throw new HttpsError('invalid-argument', 'Invalid due date.');
		await tasks.add({
			contactId,
			contactName: c.data()?.name,
			title: str(p.title, 'title'),
			dueAt: due,
			assigneeUid: str(p.assigneeUid, 'assigneeUid', false) || auth.uid,
			done: false,
			source: 'manual',
			createdAt: serverTimestamp()
		});
		return { ok: true };
	},

	'task.done': async (p: any, auth: any) => {
		const id = str(p.id, 'id');
		const ref = tasks.doc(id);
		const t = await ref.get();
		if (!t.exists) throw new HttpsError('not-found', 'Task not found.');
		const done = p.done !== false;
		await ref.update({ done, doneAt: done ? serverTimestamp() : null });
		if (done)
			await logActivity(t.data()?.contactId, 'note', `Task done: ${t.data()?.title}`, who(auth));
		return { ok: true };
	}
};
