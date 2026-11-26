import { HttpsError } from 'firebase-functions/v2/https';
import { db } from '../../firestore';
import { deleteField, serverTimestamp, str, oneOf } from '../utils';
import { callVia } from '../call-context';
import {
	CONTACT_TYPES,
	NEXT_STEPS,
	PIPELINES,
	SEGMENTS,
	STRATEGY_COLLECTION,
	STRATEGY_STATUSES,
	SOURCES,
	STALE_DAYS,
	firstStage,
	nextStepOf,
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
	/** One of NEXT_STEPS, or empty. */
	nextStep?: string;
	/** Partners only: one of SEGMENTS (VC fund, university…), or empty. */
	segment?: string;
	/** Partners only: the go-to-market strategy it belongs to, or empty. */
	strategyId?: string;
	/** Who last created it, moved its stage or set its next step in the Hub: gets the automation's
	 * task when the contact has no owner. */
	changedByUid?: string | null;
	changedByName?: string | null;
	/** Why it was lost or declined (asked when moving to such a stage). */
	lostReason?: string;
	/** What the portal sheet says, when the contact came from it (read-only copy). */
	portal?: {
		from: string;
		cohort: string | null;
		pledgeSigned: boolean | null;
		sherpaName: string | null;
		nextStep: string | null;
		/** Stage and next step the sheet had at the last sync ("whichever changed last"). */
		sheetStage?: string;
		sheetNextStep?: string;
		scoring: string | null;
		reasonLost: string | null;
		sheetNotes: string | null;
		syncedAt: FirebaseFirestore.Timestamp;
		[k: string]: unknown;
	};
	stageChangedAt: FirebaseFirestore.Timestamp;
	lastActivityAt: FirebaseFirestore.Timestamp;
	createdAt: FirebaseFirestore.Timestamp;
	updatedAt: FirebaseFirestore.Timestamp;
	createdBy: string;
	/** The latest stage move in the Hub, with what Undo puts back (`contact.undoMove`). */
	lastMove?: LastMove;
	/** The move just undone: the trigger runs no stage automation for that write. */
	undoneMove?: string;
}

export interface LastMove {
	id: string;
	from: string;
	to: string;
	prevOpen: boolean;
	prevStageChangedAt: FirebaseFirestore.Timestamp | null;
	prevLostReason: string | null;
	prevChangedByUid: string | null;
	prevChangedByName: string | null;
	prevLastActivityAt: FirebaseFirestore.Timestamp | null;
	prevNeedsAttention: boolean;
	/** Its timeline entry: while it is the latest, Undo also puts the last activity back. */
	activityId: string;
	at: FirebaseFirestore.Timestamp;
	by: string | null;
}

/** The move's id while the contact is still where that move put it, else undefined. */
export const currentMove = (c: Contact | undefined) =>
	c?.lastMove && c.lastMove.to === c.stage ? c.lastMove.id : undefined;

export type ActivityKind = 'created' | 'note' | 'stage' | 'assigned' | 'automation' | 'updated';

/** Who did it, as the timeline shows it; marked "via Claude" when the connector made the call. */
const who = (auth: any) => {
	const name = auth?.token?.name || auth?.token?.email || 'System';
	return callVia() === 'claude' ? `${name} · via Claude` : name;
};

export function config() {
	return {
		types: CONTACT_TYPES,
		sources: SOURCES,
		pipelines: PIPELINES,
		staleDays: STALE_DAYS,
		nextSteps: NEXT_STEPS,
		segments: SEGMENTS,
		strategyStatuses: STRATEGY_STATUSES
	};
}

/** The team's time zone: a due date is the end of that day here. */
const TIME_ZONE = 'Europe/Madrid';

/**
 * `YYYY-MM-DD` as 23:59:59.999 of that day in Madrid, so a task due today is not overdue until the
 * day is over. (Midnight UTC would make it overdue from the moment it is created.)
 */
export function endOfDay(date: string): Date {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (!m) throw new HttpsError('invalid-argument', 'Pick a valid due date.');
	const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
	// Madrid's offset at that moment (summer or winter time).
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: TIME_ZONE,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	}).formatToParts(new Date(utc));
	const v = (t: string) => Number(parts.find((x) => x.type === t)?.value);
	const asLocal = Date.UTC(
		v('year'),
		v('month') - 1,
		v('day'),
		v('hour'),
		v('minute'),
		v('second'),
		999
	);
	return new Date(utc - (asLocal - utc));
}

/** A timeline entry as stored in `contact/{id}/activity`. */
const entry = (
	kind: ActivityKind,
	text: string,
	by: string,
	extra: Record<string, unknown> = {}
) => ({
	kind,
	text,
	by,
	via: callVia() ?? 'hub',
	at: serverTimestamp(),
	...extra
});

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
	batch.set(ref.collection('activity').doc(), entry(kind, text, by, extra));
	batch.update(ref, { lastActivityAt: serverTimestamp(), needsAttention: false });
	await batch.commit();
	// Activity answers "no activity for N days": its check-in task is done.
	await closeAutomationTasks(contactId, ['stale-contacts']);
}

/**
 * Close a contact's open tasks made by these automations (they belonged to a stage, next step or
 * stale flag that no longer applies). Kept as done, marked superseded; manual, Claude and portal
 * tasks have no `automationId` and are never touched. One query. Returns how many.
 *
 * For a stage move (`moveId`), each is tagged `closedByMove` so Undo can reopen it, and nothing is
 * closed once that move is undone (checked in the same transaction as the Undo's).
 */
export async function closeAutomationTasks(
	contactId: string,
	automationIds: string[],
	moveId?: string
) {
	const query = tasks.where('contactId', '==', contactId).where('done', '==', false);
	const pick = (snap: FirebaseFirestore.QuerySnapshot) =>
		snap.docs.filter((d) => automationIds.includes(d.data().automationId));
	const closed = { done: true, superseded: true, doneAt: serverTimestamp() };
	if (!moveId) {
		const open = pick(await query.get());
		if (!open.length) return 0;
		const batch = db.batch();
		for (const d of open) batch.update(d.ref, closed);
		await batch.commit();
		return open.length;
	}
	return db.runTransaction(async (tx) => {
		const c = (await tx.get(contacts.doc(contactId))).data() as Contact | undefined;
		if (currentMove(c) !== moveId) return 0;
		const open = pick(await tx.get(query));
		for (const d of open) tx.update(d.ref, { ...closed, closedByMove: moveId });
		return open.length;
	});
}

/**
 * A contact's owner changed: its open automation tasks go to whoever an automation would give them
 * to now (the new owner, or with none whoever last moved the contact; see `assigneeOf`). Manual,
 * Claude and portal tasks keep their assignee. One query. Returns how many moved.
 */
export async function handOverTasks(contactId: string, assigneeUid: string | null) {
	if (!assigneeUid) return 0;
	const snap = await tasks.where('contactId', '==', contactId).where('done', '==', false).get();
	const mine = snap.docs.filter(
		(d) => d.data().automationId && d.data().assigneeUid !== assigneeUid
	);
	if (!mine.length) return 0;
	const batch = db.batch();
	for (const d of mine) batch.update(d.ref, { assigneeUid });
	await batch.commit();
	return mine.length;
}

export const strategies = db.collection(STRATEGY_COLLECTION);

/**
 * Go-to-market fields, only those present in the payload, so an update that leaves them out
 * (Claude's flf_update_contact, say) keeps what is there.
 */
function gtmFields(p: any) {
	const out: { segment?: string; strategyId?: string } = {};
	if (p.segment !== undefined) {
		const s = str(p.segment, 'segment', false);
		if (s && !SEGMENTS.some((x) => x.id === s))
			throw new HttpsError('invalid-argument', 'Invalid segment.');
		out.segment = s;
	}
	if (p.strategyId !== undefined) out.strategyId = str(p.strategyId, 'strategyId', false);
	return out;
}

async function checkStrategy(id: string | undefined) {
	if (id && !(await strategies.doc(id).get()).exists)
		throw new HttpsError('not-found', 'Strategy not found.');
}

/** How a contact is named in tasks and messages: a Partner without a main contact by its organisation. */
export const displayName = (c: { name?: string; company?: string }) =>
	c.name || c.company || 'Unnamed';

/**
 * Fields an editor may set on create or update. A name is required, except for a Partner, which
 * needs its organisation (company) and may have no main contact yet.
 */
function fields(p: any, type: string) {
	const company = str(p.company, 'company', false);
	const name = str(p.name, 'name', false);
	if (type === 'partner' ? !company : !name)
		throw new HttpsError(
			'invalid-argument',
			type === 'partner' ? 'Missing the organisation.' : 'Missing name.'
		);
	return {
		name,
		email: str(p.email, 'email', false).toLowerCase(),
		phone: str(p.phone, 'phone', false),
		company,
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
	const f = fields(p, type);
	if (f.email && (await findByEmail(f.email))) {
		throw new HttpsError(
			'already-exists',
			`A contact with ${f.email} already exists. Search the CRM to open it.`
		);
	}
	const gtm: { segment?: string; strategyId?: string } =
		type === 'partner' ? { segment: '', strategyId: '', ...gtmFields(p) } : {};
	await checkStrategy(gtm.strategyId);
	// Stage and owner are optional: the first stage, and no owner, unless the form picked them.
	const stage = p.stage ? stageOf(type, str(p.stage, 'stage')) : stageOf(type, firstStage(type));
	if (!stage) throw new HttpsError('invalid-argument', 'Invalid stage.');
	// A losing stage needs its reason: that goes through a move (contact.stage).
	if (stage.askReason)
		throw new HttpsError(
			'invalid-argument',
			`Create it in another stage, then move it to ${stage.label} with the reason.`
		);
	const ownerUid = str(p.ownerUid, 'ownerUid', false) || null;
	let ownerName: string | null = null;
	if (ownerUid) {
		const u = await db.collection('user').doc(ownerUid).get();
		if (!u.exists) throw new HttpsError('not-found', 'User not found.');
		ownerName = u.data()?.name || u.data()?.email;
	}
	const ref = contacts.doc();
	await ref.set({
		type,
		source,
		...f,
		...gtm,
		stage: stage.id,
		open: !stage.final,
		ownerUid,
		ownerName,
		needsAttention: false,
		stageChangedAt: serverTimestamp(),
		lastActivityAt: serverTimestamp(),
		createdAt: serverTimestamp(),
		updatedAt: serverTimestamp(),
		createdBy: uid,
		changedByUid: uid,
		changedByName: by
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
		const doc = await contacts.doc(id).get();
		if (!doc.exists) throw new HttpsError('not-found', 'Contact not found.');
		// Only the fields sent change: a missing one keeps its value instead of being emptied (the
		// screen sends them all; Claude's flf_update_contact sends only what it changes).
		const cur = doc.data() as Contact;
		const sent = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));
		const f = fields(
			{
				name: cur.name,
				email: cur.email,
				phone: cur.phone,
				company: cur.company,
				linkedin: cur.linkedin,
				notes: cur.notes,
				tags: cur.tags,
				...sent
			},
			cur.type
		);
		// Partner fields belong to Partners only; a strategy is checked only when it changes, so a
		// Partner whose strategy was deleted can still be saved.
		const gtm = cur.type === 'partner' ? gtmFields(p) : {};
		if (gtm.strategyId !== undefined && gtm.strategyId !== (cur.strategyId ?? ''))
			await checkStrategy(gtm.strategyId);
		if (f.email) {
			const other = await findByEmail(f.email);
			if (other && other.id !== id) {
				throw new HttpsError('already-exists', `Another contact already uses ${f.email}.`);
			}
		}
		await contacts.doc(id).update({ ...f, ...gtm, updatedAt: serverTimestamp() });
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
		const reason = str(p.reason, 'reason', false);
		if (reason.length > 500)
			throw new HttpsError('invalid-argument', 'Keep the reason under 500 characters.');
		const moveId = contacts.doc().id;
		const by = who(auth);
		const activity = doc.ref.collection('activity').doc();
		const lastMove: Omit<LastMove, 'at'> & { at: unknown } = {
			id: moveId,
			from: c.stage,
			to: stage.id,
			prevOpen: c.open,
			prevStageChangedAt: c.stageChangedAt ?? null,
			prevLostReason: c.lostReason ?? null,
			prevChangedByUid: c.changedByUid ?? null,
			prevChangedByName: c.changedByName ?? null,
			prevLastActivityAt: c.lastActivityAt ?? null,
			prevNeedsAttention: c.needsAttention ?? false,
			activityId: activity.id,
			at: serverTimestamp(),
			by: auth?.uid ?? null
		};
		// The move and its timeline entry in one write (the entry is activity, as logActivity's).
		const batch = db.batch();
		batch.update(doc.ref, {
			stage: stage.id,
			open: !stage.final,
			stageChangedAt: serverTimestamp(),
			updatedAt: serverTimestamp(),
			lastActivityAt: serverTimestamp(),
			needsAttention: false,
			changedByUid: auth?.uid ?? null,
			changedByName: by,
			// The reason belongs to a losing stage; leaving it clears it.
			lostReason: stage.askReason ? reason : '',
			lastMove
		});
		batch.set(
			activity,
			entry(
				'stage',
				`${from} → ${stage.label}${stage.askReason && reason ? `: ${reason}` : ''}`,
				by,
				{
					from: c.stage,
					to: stage.id,
					moveId
				}
			)
		);
		await batch.commit();
		await closeAutomationTasks(id, ['stale-contacts'], moveId);
		return { ok: true, moveId };
	},

	'contact.undoMove': async (p: any, auth: any) => {
		const id = str(p.id, 'id');
		const moveId = str(p.moveId, 'moveId');
		const ref = contacts.doc(id);
		const by = who(auth);
		return db.runTransaction(async (tx) => {
			const snap = await tx.get(ref);
			if (!snap.exists) throw new HttpsError('not-found', 'Contact not found.');
			const c = snap.data() as Contact;
			const m = c.lastMove;
			if (!m || m.id !== moveId || currentMove(c) !== moveId)
				throw new HttpsError(
					'failed-precondition',
					'This move can no longer be undone: the contact has changed since.'
				);
			const [closed, created, latest] = await Promise.all([
				tx.get(tasks.where('closedByMove', '==', moveId)),
				tx.get(tasks.where('createdByMove', '==', moveId)),
				tx.get(ref.collection('activity').orderBy('at', 'desc').limit(1))
			]);
			// Nothing else happened since the move: its last-activity date and flag go back too.
			const untouched = latest.docs[0]?.id === m.activityId;
			const label = (s: string) => stageOf(c.type, s)?.label ?? s;
			tx.update(ref, {
				stage: m.from,
				open: m.prevOpen,
				stageChangedAt: m.prevStageChangedAt,
				lostReason: m.prevLostReason ?? deleteField(),
				changedByUid: m.prevChangedByUid,
				changedByName: m.prevChangedByName,
				updatedAt: serverTimestamp(),
				...(untouched
					? { lastActivityAt: m.prevLastActivityAt, needsAttention: m.prevNeedsAttention }
					: {}),
				lastMove: deleteField(),
				undoneMove: moveId
			});
			for (const t of closed.docs)
				tx.update(t.ref, {
					done: false,
					doneAt: deleteField(),
					superseded: deleteField(),
					closedByMove: deleteField()
				});
			for (const t of created.docs) tx.delete(t.ref);
			tx.set(
				ref.collection('activity').doc(),
				entry('stage', `Undid move ${label(m.from)} → ${label(m.to)}`, by, {
					from: m.to,
					to: m.from
				})
			);
			return { ok: true, reopened: closed.size, deleted: created.size };
		});
	},

	'contact.nextStep': async (p: any, auth: any) => {
		const id = str(p.id, 'id');
		const value = str(p.nextStep, 'nextStep', false);
		const step = nextStepOf(value);
		if (value && !step) throw new HttpsError('invalid-argument', 'Invalid next step.');
		const doc = await contacts.doc(id).get();
		if (!doc.exists) throw new HttpsError('not-found', 'Contact not found.');
		if (((doc.data() as Contact).nextStep ?? '') === value) return { ok: true };
		await doc.ref.update({
			nextStep: value,
			updatedAt: serverTimestamp(),
			changedByUid: auth?.uid ?? null,
			changedByName: who(auth)
		});
		await logActivity(id, 'updated', `Next step: ${step?.label ?? 'none'}`, who(auth));
		return { ok: true };
	},

	'contact.assign': async (p: any, auth: any) => {
		const id = str(p.id, 'id');
		const ownerUid = str(p.ownerUid, 'ownerUid', false) || null;
		const doc = await contacts.doc(id).get();
		if (!doc.exists) throw new HttpsError('not-found', 'Contact not found.');
		let ownerName: string | null = null;
		if (ownerUid) {
			const u = await db.collection('user').doc(ownerUid).get();
			if (!u.exists) throw new HttpsError('not-found', 'User not found.');
			ownerName = u.data()?.name || u.data()?.email;
		}
		await doc.ref.update({ ownerUid, ownerName, updatedAt: serverTimestamp() });
		// No owner: back to whoever last moved it, as a new automation task would go.
		await handOverTasks(id, ownerUid || (doc.data() as Contact).changedByUid || null);
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
		// The portal sheet is their source: deleted here, the next import would bring them back.
		const stored = (await contacts.doc(id).get()).data() as Contact | undefined;
		if (stored?.source === 'portal')
			throw new HttpsError(
				'failed-precondition',
				'This contact comes from the portal sheet: remove the row there and it leaves the Hub at the next import. Until then you can mark it Lost.'
			);
		await db.recursiveDelete(contacts.doc(id));
		const open = await tasks.where('contactId', '==', id).get();
		const batch = db.batch();
		open.forEach((t) => batch.delete(t.ref));
		await batch.commit();
		return { ok: true };
	},

	'strategy.save': async (p: any, auth: any) => {
		const id = str(p.id, 'id', false);
		// Editing: fields not sent keep their stored value (Claude may send only the one it changes).
		if (id) {
			const stored = (await strategies.doc(id).get()).data();
			if (!stored) throw new HttpsError('not-found', 'Strategy not found.');
			const sent = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined));
			p = { ...stored, ...sent };
		}
		const name = str(p.name, 'name');
		if (name.length > 120)
			throw new HttpsError('invalid-argument', 'Shorten the name to 120 characters or fewer.');
		const segment = str(p.segment, 'segment', false);
		if (segment && !SEGMENTS.some((x) => x.id === segment))
			throw new HttpsError('invalid-argument', 'Invalid segment.');
		const status = oneOf(p.status || 'active', STRATEGY_STATUSES, 'status');
		const description = str(p.description, 'description', false);
		if (description.length > 5000)
			throw new HttpsError(
				'invalid-argument',
				'Shorten the approach to 5,000 characters or fewer.'
			);
		const body = {
			name,
			segment,
			status,
			description,
			updatedBy: who(auth),
			updatedAt: serverTimestamp()
		};
		if (id) {
			await strategies.doc(id).set(body, { merge: true });
			return { id };
		}
		const ref = await strategies.add({ ...body, createdAt: serverTimestamp() });
		return { id: ref.id };
	},

	'strategy.delete': async (p: any) => {
		const id = str(p.id, 'id');
		const ref = strategies.doc(id);
		if (!(await ref.get()).exists) throw new HttpsError('not-found', 'Strategy not found.');
		// Its Partners stay; they just lose the link (in batches, however many there are).
		let unlinked = 0;
		for (;;) {
			const linked = await contacts.where('strategyId', '==', id).limit(400).get();
			if (linked.empty) break;
			const batch = db.batch();
			for (const d of linked.docs)
				batch.update(d.ref, { strategyId: '', updatedAt: serverTimestamp() });
			await batch.commit();
			unlinked += linked.size;
		}
		await ref.delete();
		return { ok: true, unlinked };
	},

	'note.add': async (p: any, auth: any) => {
		await logActivity(str(p.id, 'id'), 'note', str(p.text, 'text'), who(auth));
		return { ok: true };
	},

	'task.create': async (p: any, auth: any) => {
		const contactId = str(p.contactId, 'contactId');
		const c = await contacts.doc(contactId).get();
		if (!c.exists) throw new HttpsError('not-found', 'Contact not found.');
		const due = endOfDay(str(p.dueAt, 'dueAt'));
		await tasks.add({
			contactId,
			contactName: displayName(c.data() ?? {}),
			title: str(p.title, 'title'),
			dueAt: due,
			// Left out: the caller. Sent empty ("Nobody"): unassigned.
			assigneeUid:
				p.assigneeUid === undefined ? auth.uid : str(p.assigneeUid, 'assigneeUid', false) || null,
			done: false,
			source: callVia() === 'claude' ? 'claude' : 'manual',
			createdAt: serverTimestamp()
		});
		return { ok: true };
	},

	'task.update': async (p: any) => {
		const ref = tasks.doc(str(p.id, 'id'));
		const t = (await ref.get()).data();
		if (!t) throw new HttpsError('not-found', 'Task not found.');
		// The portal sheet rewrites a portal task's title and date at every sync; its assignee sticks.
		if (t.source === 'portal' && (p.title !== undefined || p.dueAt !== undefined))
			throw new HttpsError(
				'failed-precondition',
				'This task comes from the portal sheet: change its title and date there. You can change who it is for here.'
			);
		// Only the fields sent change (Claude's flf_update_task may send just one).
		const out: Record<string, unknown> = {};
		if (p.title !== undefined) out.title = str(p.title, 'title');
		// '' clears the date.
		if (p.dueAt !== undefined) out.dueAt = str(p.dueAt, 'dueAt', false) ? endOfDay(p.dueAt) : null;
		if (p.assigneeUid !== undefined) {
			const uid = str(p.assigneeUid, 'assigneeUid', false) || null;
			if (uid && !(await db.collection('user').doc(uid).get()).exists)
				throw new HttpsError('not-found', 'User not found.');
			out.assigneeUid = uid;
		}
		if (Object.keys(out).length) await ref.update(out);
		return { ok: true };
	},

	'task.delete': async (p: any) => {
		const ref = tasks.doc(str(p.id, 'id'));
		const t = (await ref.get()).data();
		if (!t) throw new HttpsError('not-found', 'Task not found.');
		// The sheet would bring it back at the next sync.
		if (t.source === 'portal')
			throw new HttpsError(
				'failed-precondition',
				'This task comes from the portal sheet: remove the row there, or tick it done here.'
			);
		await ref.delete();
		return { ok: true };
	},

	'task.done': async (p: any, auth: any) => {
		const id = str(p.id, 'id');
		const ref = tasks.doc(id);
		const t = await ref.get();
		if (!t.exists) throw new HttpsError('not-found', 'Task not found.');
		const done = p.done !== false;
		await ref.update({
			done,
			doneAt: done ? serverTimestamp() : null,
			// Reopened by hand: no longer "closed because the contact moved on".
			...(done ? {} : { superseded: false })
		});
		// Tasks imported from the portal sheet belong to no contact.
		if (done && t.data()?.contactId) {
			await logActivity(t.data()?.contactId, 'note', `Task done: ${t.data()?.title}`, who(auth));
		}
		return { ok: true };
	}
};
