import { get } from 'svelte/store';
import {
	onSnapshot,
	type DocumentData,
	type Query,
	type DocumentReference
} from 'firebase/firestore';
import { me, pageTitle } from '$lib/stores';

/**
 * Whether the signed-in user has a permission. `'a | b'` = any, `'a & b'` = all.
 * Admins pass every check.
 */
export function hasPermission(expr: string): boolean {
	const user = get(me);
	if (!user) return false;
	if (user.role === 'admin') return true;
	const has = (p: string) => user.permissions.includes(p.trim());
	if (expr.includes('|')) return expr.split('|').some(has);
	if (expr.includes('&')) return expr.split('&').every(has);
	return has(expr);
}

export function setTitle(title: string, subtitle?: string) {
	pageTitle.set({ title, subtitle });
}

type Row<T> = T & { id: string };

/** Live list of a query's documents. Returns the unsubscribe. */
export function listen<T = DocumentData>(
	q: Query,
	onData: (rows: Row<T>[]) => void,
	onError?: (e: Error) => void
) {
	return onSnapshot(
		q,
		(snap) => onData(snap.docs.map((d) => ({ id: d.id, ...(d.data() as T) }))),
		(e) => (onError ? onError(e) : console.error(e))
	);
}

/** Live single document (null when missing). Returns the unsubscribe. */
export function listenDoc<T = DocumentData>(
	ref: DocumentReference,
	onData: (row: Row<T> | null) => void
) {
	return onSnapshot(ref, (d) => onData(d.exists() ? { id: d.id, ...(d.data() as T) } : null));
}

/** A Firestore timestamp, millis or Date as a Date. */
export function toDate(value: unknown): Date | null {
	if (!value) return null;
	if (value instanceof Date) return value;
	if (typeof value === 'number') return new Date(value);
	if (typeof value === 'object' && value && 'toDate' in value) {
		return (value as { toDate: () => Date }).toDate();
	}
	return null;
}

const dateFmt = new Intl.DateTimeFormat('en-GB', {
	day: 'numeric',
	month: 'short',
	year: 'numeric'
});
const dateTimeFmt = new Intl.DateTimeFormat('en-GB', {
	day: 'numeric',
	month: 'short',
	hour: '2-digit',
	minute: '2-digit'
});

/** All user-facing dates go through these two. */
export function formatDate(value: unknown): string {
	const d = toDate(value);
	return d ? dateFmt.format(d) : '—';
}

export function formatDateTime(value: unknown): string {
	const d = toDate(value);
	return d ? dateTimeFmt.format(d) : '—';
}

/** "3 days ago", "in 2 hours". */
export function relative(value: unknown): string {
	const d = toDate(value);
	if (!d) return '—';
	const diff = d.getTime() - Date.now();
	const abs = Math.abs(diff);
	const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
	if (abs < 3600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
	if (abs < 86_400_000) return rtf.format(Math.round(diff / 3600_000), 'hour');
	return rtf.format(Math.round(diff / 86_400_000), 'day');
}
