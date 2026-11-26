import { callAction, errorText } from '$lib/actions';
import { toDate } from '$lib/utils';
import type { CrmConfig, ContactType } from '$lib/types/crm';

/** The CRM config, fetched once per session from `crm:config.get`. */
let config = $state<CrmConfig | null>(null);
let loading: Promise<CrmConfig> | null = null;

export function crmConfig() {
	if (!config && !loading) {
		loading = callAction<CrmConfig>('crm:config.get').then((c) => (config = c));
	}
	return {
		get value() {
			return config;
		}
	};
}

/**
 * How a contact is titled: a Partner by its organisation (company), with the main contact below;
 * everyone else by name, with the company below.
 */
export function contactTitle(c: { type: string; name: string; company?: string }) {
	return c.type === 'partner' ? c.company || c.name : c.name;
}
export function contactSubtitle(c: { type: string; name: string; company?: string }) {
	if (c.type !== 'partner') return c.company ?? '';
	return c.company ? c.name : '';
}

/** The open "why lost?" question, answered by `ReasonDialog` (mounted on the CRM and contact pages). */
export const reasonAsk = $state<{
	current: { stage: string; name: string; resolve: (r: string | null) => void } | null;
}>({ current: null });

/**
 * The reason for moving a contact to a losing stage (Lost, Declined): asked in a dialog, before the
 * move. '' for any other stage; null when the person cancels, so nothing moves.
 */
export function askReason(
	stage: { label: string; askReason?: boolean } | undefined,
	name: string
): Promise<string | null> {
	if (!stage?.askReason) return Promise.resolve('');
	reasonAsk.current?.resolve(null);
	return new Promise((resolve) => {
		reasonAsk.current = { stage: stage.label, name, resolve };
	});
}

/** The latest stage move, offering Undo for 8 seconds (`MoveNotice`, on the board and contact page). */
export const moveNotice = $state<{
	current: { contactId: string; moveId: string; name: string; stage: string } | null;
}>({ current: null });
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function showMove(n: (typeof moveNotice)['current']) {
	clearTimeout(noticeTimer);
	moveNotice.current = n;
	if (n) noticeTimer = setTimeout(() => (moveNotice.current = null), 8000);
}

/**
 * Move a contact to a stage, asking the reason for a losing one first; `optimistic` shows the move
 * at once and returns how to take it back on failure. Returns the error text, or null.
 */
export async function moveContact(
	c: { id: string; type: string; name: string; company?: string },
	to: { id: string; label: string; askReason?: boolean },
	optimistic?: () => () => void
): Promise<string | null> {
	const name = contactTitle(c);
	const reason = await askReason(to, name);
	if (reason === null) return null;
	const rollback = optimistic?.();
	try {
		const r = await callAction<{ moveId?: string }>('crm:contact.stage', {
			id: c.id,
			stage: to.id,
			reason
		});
		if (r.moveId) showMove({ contactId: c.id, moveId: r.moveId, name, stage: to.label });
		return null;
	} catch (e) {
		rollback?.();
		return errorText(e);
	}
}

/** Undo the move in the notice: the server puts the contact and its tasks back. Error text or null. */
export async function undoMove(): Promise<string | null> {
	const n = moveNotice.current;
	// The notice goes first, so a second click can't undo twice.
	showMove(null);
	if (!n) return null;
	try {
		await callAction('crm:contact.undoMove', { id: n.contactId, moveId: n.moveId });
		return null;
	} catch (e) {
		return errorText(e);
	}
}

/** The CRM list as last shown (tab, view, filters), so a contact's back link returns to it. */
export const crmBack = $state({ href: '/crm' });

/**
 * Tick a task done (or not) from a list row. On failure the box goes back and the error is
 * returned; null when it worked.
 */
export async function tickTask(id: string, box: HTMLInputElement): Promise<string | null> {
	try {
		await callAction('crm:task.done', { id, done: box.checked });
		return null;
	} catch (e) {
		box.checked = !box.checked;
		return errorText(e);
	}
}

export function stageLabel(c: CrmConfig | null, type: ContactType, stage: string): string {
	return c?.pipelines[type]?.stages.find((s) => s.id === stage)?.label ?? stage;
}

/** Badge colours, given out in the order of `config.types`. */
const TYPE_STYLES = [
	'bg-primary-50 text-primary-700',
	'bg-amber-50 text-amber-800',
	'bg-sky-50 text-sky-800',
	'bg-canvas text-ink-soft'
];

export function typeStyle(c: CrmConfig | null, type: ContactType): string {
	const i = c?.types.indexOf(type) ?? -1;
	return TYPE_STYLES[i >= 0 && i < TYPE_STYLES.length ? i : TYPE_STYLES.length - 1];
}

const DAY = 86_400_000;

/** Whole days since a contact's last activity, or null when unknown. */
export function daysQuiet(c: { lastActivityAt: unknown }, now = Date.now()): number | null {
	const t = toDate(c.lastActivityAt)?.getTime();
	return t ? Math.max(0, Math.floor((now - t) / DAY)) : null;
}

/**
 * Needs attention, live: open and no activity for `staleDays` (the daily job's flag lags up to a
 * day). Returns the days without activity, or null when it doesn't need attention.
 */
export function attentionDays(
	c: { open: boolean; lastActivityAt: unknown },
	staleDays: number,
	now = Date.now()
): number | null {
	const d = daysQuiet(c, now);
	return c.open && d !== null && d >= staleDays ? d : null;
}

/** "Website" for the stored "website": labels only, the value stays. */
export const sourceLabel = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "AB" for "Ana Bravo", for owner avatars. */
export function initials(name: string | null | undefined): string {
	const parts = (name ?? '').split(/[\s@.]+/).filter(Boolean);
	return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}
