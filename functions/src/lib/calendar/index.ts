import { GoogleAuth } from 'google-auth-library';
import { db } from '../../firestore';
import { createLogger } from '../utils';
import * as crm from '../crm/index';

/**
 * Upcoming meetings, read live from Google Calendar (docs/calendar.md). Read only: events.list
 * (GET) with the calendar.readonly scope, as the Functions service account the calendars are
 * shared with. Nothing is stored in Firestore.
 */

const logger = createLogger('calendar');
const DAY = 86_400_000;
/** How far ahead Events → Upcoming looks. */
export const UPCOMING_DAYS = 30;
/** Events read per calendar (Google's events.list page size). */
const MAX_EVENTS = 100;
/** One result per instance for this long: the page and Claude reread no calendar or contact. */
const CACHE_MS = 5 * 60_000;

export interface Attendee {
	email: string;
	name: string | null;
	/** The CRM contact with this email (or one of its other emails), when there is one. */
	contactId: string | null;
	contactName: string | null;
}

export interface UpcomingMeeting {
	id: string;
	calendarId: string;
	title: string;
	/** ISO date-time, or YYYY-MM-DD for an all-day event. */
	start: string;
	end: string;
	allDay: boolean;
	location: string | null;
	meetLink: string | null;
	attendees: Attendee[];
}

export interface Upcoming {
	/** False until the Calendar connection has at least one calendar id. */
	configured: boolean;
	days: number;
	meetings: UpcomingMeeting[];
	/** Calendars that could not be read, with why (others are still listed). */
	errors: { calendarId: string; message: string }[];
}

/** The configured calendar ids: one per line in the connection's settings. */
export async function calendarIds(): Promise<string[]> {
	const settings = (await db.collection('connection').doc('calendar').get()).data()?.settings;
	return idsOf(settings?.calendars);
}

export const idsOf = (value: string | undefined) => [
	...new Set(
		(value ?? '')
			.split('\n')
			.map((x) => x.trim())
			.filter(Boolean)
	)
];

interface GEvent {
	id: string;
	iCalUID?: string;
	status?: string;
	summary?: string;
	location?: string;
	hangoutLink?: string;
	conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
	start?: { dateTime?: string; date?: string };
	end?: { dateTime?: string; date?: string };
	attendees?: { email?: string; displayName?: string; resource?: boolean }[];
}

/** One calendar's events between two dates, expanded and ordered by start. GET only. */
async function listEvents(calendarId: string, from: Date, to: Date): Promise<GEvent[]> {
	const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/calendar.readonly'] });
	const client = await auth.getClient();
	const params = new URLSearchParams({
		timeMin: from.toISOString(),
		timeMax: to.toISOString(),
		singleEvents: 'true',
		orderBy: 'startTime',
		maxResults: String(MAX_EVENTS)
	});
	const res = await client.request<{ items?: GEvent[] }>({
		url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
		method: 'GET'
	});
	return (res.data.items ?? []).filter((e) => e.status !== 'cancelled');
}

/** Why a calendar can't be read, in plain words. */
function reason(err: unknown): string {
	const status = (err as { response?: { status?: number } })?.response?.status;
	if (status === 404 || status === 403)
		return 'Not shared with the Hub: share it with 900685987021-compute@developer.gserviceaccount.com ("See all event details").';
	return err instanceof Error ? err.message : String(err);
}

/** Connection check: each calendar's next 7 days. */
export async function check(
	calendars: string | undefined
): Promise<{ status: 'ok' | 'error' | 'not_configured'; detail: string; hint?: string }> {
	const ids = idsOf(calendars);
	if (!ids.length)
		return {
			status: 'not_configured',
			detail: 'No calendar ids yet.',
			hint: 'Open it on Connections and follow “How to set it up”.'
		};
	const now = new Date();
	const lines: string[] = [];
	let failed = false;
	for (const id of ids) {
		try {
			const n = (await listEvents(id, now, new Date(now.getTime() + 7 * DAY))).length;
			lines.push(`${id}: ${n} event${n === 1 ? '' : 's'} in the next 7 days`);
		} catch (err) {
			failed = true;
			lines.push(`${id}: ${reason(err)}`);
		}
	}
	return failed
		? {
				status: 'error',
				detail: lines.join(' · '),
				hint: 'The Hub can’t read a calendar. Check its id and that it is shared with the Hub (“See all event details”), then press Test.'
			}
		: { status: 'ok', detail: lines.join(' · ') };
}

/**
 * Contacts by attendee email: per 30 emails, one `in` query on `email` and one `array-contains-any`
 * on `otherEmails` (each one billed read when nothing matches, else one per contact found).
 */
async function contactsByEmail(emails: string[]) {
	const out = new Map<string, { id: string; name: string }>();
	for (let i = 0; i < emails.length; i += 30) {
		const part = emails.slice(i, i + 30);
		const [main, other] = await Promise.all([
			crm.contacts.where('email', 'in', part).get(),
			crm.contacts.where('otherEmails', 'array-contains-any', part).get()
		]);
		for (const d of [...other.docs, ...main.docs]) {
			const c = d.data();
			const row = { id: d.id, name: crm.displayName(c) };
			for (const e of [c.email, ...((c.otherEmails as string[] | undefined) ?? [])])
				if (e && part.includes(String(e).toLowerCase())) out.set(String(e).toLowerCase(), row);
		}
	}
	return out;
}

let cache: { key: string; at: number; value: Upcoming } | null = null;

/** The next 30 days across the configured calendars, soonest first. Cached 5 minutes per instance. */
export async function upcoming(): Promise<Upcoming> {
	const ids = await calendarIds();
	if (!ids.length) return { configured: false, days: UPCOMING_DAYS, meetings: [], errors: [] };
	const key = ids.join('\n');
	if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.value;

	const from = new Date();
	const to = new Date(from.getTime() + UPCOMING_DAYS * DAY);
	const errors: Upcoming['errors'] = [];
	const read = await Promise.all(
		ids.map(async (calendarId) => {
			try {
				return (await listEvents(calendarId, from, to)).map((e) => ({ calendarId, e }));
			} catch (err) {
				logger.warn(`${calendarId}: ${reason(err)}`);
				errors.push({ calendarId, message: reason(err) });
				return [];
			}
		})
	);
	// One meeting in several team calendars is listed once.
	const seen = new Set<string>();
	const events = read.flat().filter(({ e }) => {
		const k = `${e.iCalUID ?? e.id}|${e.start?.dateTime ?? e.start?.date}`;
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
	// The team's own calendars are not guests.
	const own = new Set(ids.map((x) => x.toLowerCase()));
	const emails = [
		...new Set(
			events.flatMap(({ e }) =>
				(e.attendees ?? [])
					.filter((a) => a.email && !a.resource)
					.map((a) => a.email!.toLowerCase())
					.filter((x) => !own.has(x))
			)
		)
	];
	const matched = await contactsByEmail(emails);
	const meetings: UpcomingMeeting[] = events
		.map(({ calendarId, e }) => ({
			id: e.id,
			calendarId,
			title: e.summary || '(no title)',
			start: e.start?.dateTime ?? e.start?.date ?? '',
			end: e.end?.dateTime ?? e.end?.date ?? '',
			allDay: !e.start?.dateTime,
			location: e.location || null,
			meetLink:
				e.hangoutLink ||
				e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri ||
				null,
			attendees: (e.attendees ?? [])
				.filter((a) => a.email && !a.resource && !own.has(a.email.toLowerCase()))
				.map((a) => {
					const c = matched.get(a.email!.toLowerCase());
					return {
						email: a.email!.toLowerCase(),
						name: a.displayName || null,
						contactId: c?.id ?? null,
						contactName: c?.name ?? null
					};
				})
		}))
		.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
	const value = { configured: true, days: UPCOMING_DAYS, meetings, errors };
	// A failed calendar is read again on the next call, not five minutes later.
	if (!errors.length) cache = { key, at: Date.now(), value };
	return value;
}
