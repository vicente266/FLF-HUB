import { HttpsError } from 'firebase-functions/v2/https';
import { db } from '../../firestore';
import { callVia } from '../call-context';
import { createLogger, serverTimestamp, str } from '../utils';
import { KNOWLEDGE_COLLECTION, MAX_DESCRIPTION, MAX_ENTRIES, MAX_LABEL } from './config';

/**
 * The team's knowledge list (docs/knowledge.md), ported from the EBS Hub's knowledge store. One
 * document per entry; an entry with `expiredAt` (`YYYY-MM-DD`) before today is inactive: kept and
 * shown struck through, but never handed to Claude. The list is settings-sized, so it is read whole
 * and filtered in memory, fresh on every use, so an expiry takes effect the day it passes.
 */

const logger = createLogger('knowledge');
export const collection = db.collection(KNOWLEDGE_COLLECTION);

export interface Knowledge {
	label?: string;
	description: string;
	/** Optional expiry as `YYYY-MM-DD`; valid through that day. */
	expiredAt?: string;
}

/** Today as `YYYY-MM-DD` (UTC). ISO dates compare as strings. */
const todayIso = () => new Date().toISOString().slice(0, 10);

export function isExpired(entry: { expiredAt?: string }, today = todayIso()): boolean {
	return !!entry.expiredAt && entry.expiredAt < today;
}

/**
 * One entry as its own `<entry label="…" valid_until="…">` block, text verbatim inside, so Claude
 * always sees where an entry starts and ends and its own bullets never run into the next one.
 */
function toEntry(entry: Knowledge): string {
	const label = entry.label?.trim().replace(/"/g, "'");
	const expiredAt = entry.expiredAt?.trim();
	const description = entry.description?.trim() ?? '';
	if (!description) return label ? `<entry>\n${label}\n</entry>` : '';
	const attrs = [label && ` label="${label}"`, expiredAt && ` valid_until="${expiredAt}"`]
		.filter(Boolean)
		.join('');
	return `<entry${attrs}>\n${description}\n</entry>`;
}

/** Active entries joined into one block, one `<entry>` each. */
export function formatKnowledge(entries: Knowledge[]): string {
	const today = todayIso();
	return entries
		.filter((e) => !isExpired(e, today))
		.map(toEntry)
		.filter(Boolean)
		.join('\n\n');
}

export async function list(): Promise<(Knowledge & { id: string; updatedBy?: string })[]> {
	const snap = await collection.orderBy('createdAt').limit(MAX_ENTRIES).get();
	return snap.docs.map((d) => ({
		id: d.id,
		label: d.data().label ?? '',
		description: d.data().description ?? '',
		expiredAt: d.data().expiredAt ?? '',
		updatedBy: d.data().updatedBy ?? ''
	}));
}

/** The active block (empty string when none), read fresh so expiry is honoured. */
export async function activeText(): Promise<string> {
	return formatKnowledge(await list());
}

const who = (auth: any) => {
	const name = auth?.token?.name || auth?.token?.email || 'System';
	return callVia() === 'claude' ? `${name} · via Claude` : name;
};

function clean(p: any): Required<Knowledge> {
	const description = str(p?.description, 'description');
	if (description.length > MAX_DESCRIPTION)
		throw new HttpsError(
			'invalid-argument',
			`The description is too long (${MAX_DESCRIPTION} characters at most).`
		);
	const label = str(p?.label, 'label', false);
	if (label.length > MAX_LABEL)
		throw new HttpsError(
			'invalid-argument',
			`Shorten the label to ${MAX_LABEL} characters or fewer.`
		);
	const expiredAt = str(p?.expiredAt, 'expiredAt', false);
	if (expiredAt && !/^\d{4}-\d{2}-\d{2}$/.test(expiredAt))
		throw new HttpsError('invalid-argument', 'Pick a valid expiry date.');
	return { label, description, expiredAt };
}

export const actions = {
	/** Every entry, active and expired, oldest first. */
	list: async () => {
		const entries = await list();
		return { entries, active: formatKnowledge(entries) };
	},

	/** Create (no id) or update an entry; returns its id. */
	save: async (p: any, auth: any) => {
		const id = str(p?.id, 'id', false);
		let entry = p?.entry ?? {};
		const ref = id ? collection.doc(id) : null;
		if (ref) {
			// Editing: fields not sent keep their stored value (Claude may send only the one it changes).
			const stored = (await ref.get()).data();
			if (!stored) throw new HttpsError('not-found', 'Entry not found.');
			const sent = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== undefined));
			entry = {
				label: stored.label,
				description: stored.description,
				expiredAt: stored.expiredAt,
				...sent
			};
		}
		const body = { ...clean(entry), updatedBy: who(auth), updatedAt: serverTimestamp() };
		if (ref) {
			await ref.set(body, { merge: true });
			logger.log(`updated ${id}`);
			return { id };
		}
		if ((await collection.count().get()).data().count >= MAX_ENTRIES)
			throw new HttpsError(
				'resource-exhausted',
				`Knowledge is full (${MAX_ENTRIES} entries). Delete expired entries to add new ones.`
			);
		const added = await collection.add({ ...body, createdAt: serverTimestamp() });
		logger.log(`created ${added.id}`);
		return { id: added.id };
	},

	/** Delete an entry. */
	delete: async (p: any) => {
		const id = str(p?.id, 'id');
		const ref = collection.doc(id);
		if (!(await ref.get()).exists) throw new HttpsError('not-found', 'Entry not found.');
		await ref.delete();
		logger.log(`deleted ${id}`);
		return { ok: true };
	}
};
