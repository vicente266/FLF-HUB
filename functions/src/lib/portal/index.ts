import { createHash } from 'crypto';
import { HttpsError } from 'firebase-functions/v2/https';
import { db } from '../../firestore';
import { createLogger, serverTimestamp, Timestamp } from '../utils';
import * as crm from '../crm/index';
import { nextStepFromSheet, nextStepOf, stageOf } from '../crm/config';
import { readSheet, collection as connectionCollection } from '../connections/index';
import {
	DEFAULT_SPREADSHEET_ID,
	EVENT_PARTICIPANTS,
	MAX_ROWS,
	STAGE_MAP,
	TABS,
	type TabKey
} from './config';

/**
 * Read-only import of the FLF Portal sheet into the Hub (docs/portal-import.md). The sheet stays
 * the portal's live database: the import reads it, never writes it, and can be run again at any
 * time (it upserts by a stable id). While the portal is live the sheet wins for the fields it
 * owns; the Hub keeps its own timeline, tasks and owner.
 */

const logger = createLogger('portal');
export const wellbeing = db.collection('wellbeing');
export const finance = db.collection('fellowFinance');
/** Meetings from the sheet's Events tab (filled by n8n's "Calendar → Events database"). */
export const events = db.collection('event');

/** One tab, as header → value objects, and the headers it is missing. */
export interface Tab {
	rows: Record<string, string>[];
	missing: string[];
	/** More rows than MAX_ROWS: the tail was not read, so nothing may be removed for being absent. */
	truncated?: boolean;
}

/**
 * A cell's text; a spreadsheet error (`#DIV/0!`, `#N/A`, `#REF!`…) reads as empty, also when the
 * sheet appends its explanation ("#DIV/0! (Function DIVIDE parameter 2 cannot be zero.)").
 */
const norm = (s: unknown) => {
	const v = String(s ?? '').trim();
	return /^#(DIV\/0!|N\/A|VALUE!|REF!|NAME\?|NUM!|NULL!|ERROR!)(\s|$)/i.test(v) ? '' : v;
};
const lower = (s: unknown) => norm(s).toLowerCase();
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);

/**
 * A cell's addresses, lowercased. The CRM tab sometimes holds two in one cell ("a@x.com, b@y.com"):
 * the first is the person's email and identity, the others are kept as other emails.
 */
export function emailsOf(cell: string): string[] {
	return lower(cell)
		.split(/[\s,;]+/)
		.filter((e) => e.includes('@'));
}
const primaryEmail = (cell: string) => emailsOf(cell)[0] ?? '';

/** The Hub id of a person from the sheet: by (first) email, or by name when there is none. */
/**
 * The id a person had before the first-email identity, keyed by the whole Email cell. Kept so a
 * contact made then is moved to its new id instead of left behind as a duplicate.
 */
export function legacyContactIdOf(email: string, name: string): string {
	return `portal-${hash(lower(email) || `name:${lower(name)}`)}`;
}

export function contactIdOf(email: string, name: string): string {
	const key = primaryEmail(email) || `name:${lower(name)}`;
	return `portal-${hash(key)}`;
}

/** Rows as objects keyed by header, keeping only the configured columns. */
export function toTab(values: string[][], columns: readonly string[]): Tab {
	const header = (values[0] ?? []).map(norm);
	const missing = columns.filter((c) => !header.includes(c));
	const index = new Map(columns.map((c) => [c, header.indexOf(c)]));
	const truncated = values.length - 1 > MAX_ROWS;
	const rows = values
		.slice(1, MAX_ROWS + 1)
		.map((r) =>
			Object.fromEntries(columns.map((c) => [c, index.get(c)! >= 0 ? norm(r[index.get(c)!]) : '']))
		)
		.filter((r) => Object.values(r).some(Boolean));
	return { rows, missing, truncated };
}

/** `dd/mm/yyyy`, `yyyy-mm-dd` or a sheet date as a Date, else null. */
export function parseDate(value: string): Date | null {
	const v = norm(value);
	let m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v);
	if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], 12));
	m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
	if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
	return null;
}

const num = (v: string) => {
	const n = Number(
		norm(v)
			.replace(/[^\d.,-]/g, '')
			.replace(',', '.')
	);
	return Number.isFinite(n) && norm(v) !== '' ? n : null;
};
const yes = (v: string) => ['true', 'yes', 'sí', 'si', '1', 'x'].includes(lower(v));

async function spreadsheetId(): Promise<string> {
	const s = (await connectionCollection.doc('portal-sheet').get()).data()?.settings ?? {};
	return norm(s.spreadsheetId) || DEFAULT_SPREADSHEET_ID;
}

/** Every configured tab, read once. Throws when the sheet can't be read at all. */
export async function readAll(): Promise<Record<TabKey, Tab>> {
	const id = await spreadsheetId();
	const out = {} as Record<TabKey, Tab>;
	for (const key of Object.keys(TABS) as TabKey[]) {
		const tab = TABS[key];
		out[key] = toTab(await readSheet(id, `'${tab.name}'`), tab.columns);
	}
	return out;
}

/** What the import would write, computed without writing anything. */
export interface Plan {
	contacts: { id: string; data: Record<string, unknown>; from: string }[];
	tasks: { id: string; data: Record<string, unknown> }[];
	wellbeing: { id: string; data: Record<string, unknown> }[];
	finance: { id: string; data: Record<string, unknown> }[];
	/** Meetings; each also lands on its participants' timelines. */
	events: { id: string; data: CalendarEvent }[];
	skipped: string[];
	/** Tabs read only in part (over MAX_ROWS): nothing is removed for being absent from them. */
	truncated: TabKey[];
	drift: Record<string, string[]>;
}

/** One meeting from the Events tab. */
export interface CalendarEvent {
	title: string;
	type: string;
	date: Date | null;
	description: string;
	showInPortal: boolean;
	participants: { name: string; contactId: string | null }[];
	/** Contacts among the participants, for "this contact's meetings". */
	contactIds: string[];
}

/**
 * The plan, from the tabs. Pure: no reads or writes, so it is what the dry run shows and what the
 * tests exercise. Precedence for a person: CRM tab (stage) > Profiles (a Fellow) > Applications.
 */
export function plan(
	tabs: Record<TabKey, Tab>,
	team: { uid: string; name: string; email?: string }[]
): Plan {
	const p: Plan = {
		contacts: [],
		tasks: [],
		wellbeing: [],
		finance: [],
		events: [],
		skipped: [],
		truncated: [],
		drift: {}
	};
	for (const [k, t] of Object.entries(tabs)) {
		if (t.missing.length) p.drift[TABS[k as TabKey].name] = t.missing;
		if (t.truncated) p.truncated.push(k as TabKey);
	}

	const byId = new Map<string, { data: Record<string, unknown>; from: string }>();
	const put = (id: string, data: Record<string, unknown>, from: string) => {
		const prev = byId.get(id);
		// Earlier sources win the stage; later ones only fill fields still empty.
		if (!prev) byId.set(id, { data, from });
		else {
			for (const [k, v] of Object.entries(data)) {
				if (Array.isArray(prev.data[k]) && Array.isArray(v))
					prev.data[k] = [...new Set([...(prev.data[k] as unknown[]), ...v])];
				else if (prev.data[k] === undefined || prev.data[k] === '' || prev.data[k] === null)
					prev.data[k] = v;
			}
			prev.from = `${prev.from}+${from}`;
		}
	};
	// The sheet names a Sherpa or task owner by Username ("Aleks"), Name or first name; a Profiles
	// row of the team (Admin, Sherpa) links those to an email, and the email to a Hub user.
	const teamRows = tabs.profiles.missing.length
		? []
		: tabs.profiles.rows.filter((r) => ['admin', 'sherpa'].includes(lower(r['Role'])));
	const ownerOf = (name: string) => {
		const n = lower(name);
		if (!n) return null;
		const byName = (u: { name: string }) =>
			lower(u.name) === n || lower(u.name).split(' ')[0] === n;
		const direct = team.find(byName);
		if (direct) return direct;
		const row = teamRows.find(
			(r) =>
				lower(r['Username']) === n || lower(r['Name']) === n || lower(r['Name']).split(' ')[0] === n
		);
		if (!row) return null;
		const emails = emailsOf(row['Email']);
		return (
			team.find((u) => u.email && emails.includes(lower(u.email))) ??
			team.find((u) => lower(u.name) === lower(row['Name'])) ??
			null
		);
	};

	// The team (Profiles role Admin or Sherpa) are users of the Hub, not contacts: their CRM rows,
	// applications, check-ins and reports stay out of the Fellow data.
	const teamEmails = new Set(teamRows.flatMap((r) => emailsOf(r['Email'])));
	const isTeam = (cell: string) => emailsOf(cell).some((e) => teamEmails.has(e));

	if (!tabs.crm.missing.length) {
		for (const r of tabs.crm.rows) {
			if (!r['Name'] && !r['Email']) continue;
			if (isTeam(r['Email'])) {
				p.skipped.push(`CRM: "${r['Name']}" is on the team (Profiles role), not a contact`);
				continue;
			}
			const stage = STAGE_MAP[lower(r['Stage'])];
			if (!stage) {
				p.skipped.push(`CRM: unknown stage "${r['Stage']}"`);
				continue;
			}
			put(
				contactIdOf(r['Email'], r['Name']),
				{
					legacyIds: [legacyContactIdOf(r['Email'], r['Name'])],
					name: r['Name'] || r['Email'],
					email: primaryEmail(r['Email']),
					otherEmails: emailsOf(r['Email']).slice(1),
					company: r['Company Name'],
					stage,
					nextStep: r['Status'],
					scoring: r['Scoring'],
					reasonLost: r['Reason Lost'],
					sheetNotes: r['Notes'],
					lastMeeting: parseDate(r['Last Meeting (N8N)'])
				},
				'crm'
			);
		}
	}

	if (!tabs.profiles.missing.length) {
		for (const r of tabs.profiles.rows) {
			// Admins and Sherpas are the team, not contacts.
			if (lower(r['Role']) !== 'fellow') continue;
			const owner = ownerOf(r['Sherpa Name']);
			put(
				contactIdOf(r['Email'], r['Name']),
				{
					legacyIds: [legacyContactIdOf(r['Email'], r['Name'])],
					name: r['Name'] || r['Email'],
					email: primaryEmail(r['Email']),
					otherEmails: emailsOf(r['Email']).slice(1),
					company: r['Company Name'],
					linkedin: r['LinkedIn'],
					stage: 'fellow',
					cohort: r['Cohort'],
					// The column holds "TRUE" or the signing date.
					pledgeSigned: yes(r['Pledge Signed']) || !!parseDate(r['Pledge Signed']),
					pledgeDate: parseDate(r['Pledge Date']),
					companyUrl: r['Company URL'],
					location: r['Location'],
					sherpaName: r['Sherpa Name'],
					archetype: r['Archetype'],
					funnelStage: r['Funnel Stage'],
					onPortal: r['Show in portal'] ? yes(r['Show in portal']) : null,
					contractUrl: r['Contract URL'],
					reasonsWhy: r['Reasons Why'],
					lastInteraction: parseDate(r['Last Interaction']),
					...(owner ? { ownerUid: owner.uid, ownerName: owner.name } : {})
				},
				'profiles'
			);
			// Income is financial data: kept apart, behind wealth.any.read.
			const id = contactIdOf(r['Email'], r['Name']);
			p.finance.push({
				id,
				data: {
					contactId: id,
					startingIncome: num(r['Starting Income']),
					currentIncome: num(r['Current Income']),
					growth: r['Growth'],
					reports: {}
				}
			});
		}
	}

	if (!tabs.applications.missing.length) {
		for (const r of tabs.applications.rows) {
			if (!r['Email'] && !r['Name']) continue;
			if (isTeam(r['Email'])) continue;
			// Test submissions of the portal's form are not applicants.
			if (/@example\.(com|org)$/.test(primaryEmail(r['Email'])) || /^test\b/i.test(r['Company'])) {
				p.skipped.push(`Applications: test row "${r['Name']}" (${r['Company'] || 'no company'})`);
				continue;
			}
			put(
				contactIdOf(r['Email'], r['Name']),
				{
					legacyIds: [legacyContactIdOf(r['Email'], r['Name'])],
					name: r['Name'] || r['Email'],
					email: primaryEmail(r['Email']),
					otherEmails: emailsOf(r['Email']).slice(1),
					company: r['Company'],
					linkedin: r['LinkedIn'],
					stage: 'application',
					nextStep: r['Status'],
					sheetNotes: [
						r['WhyNow'] && `Why now: ${r['WhyNow']}`,
						r['ReferredBy'] && `Referred by: ${r['ReferredBy']}`
					]
						.filter(Boolean)
						.join('\n'),
					appliedAt: parseDate(r['AppliedAt'])
				},
				'applications'
			);
		}
	}

	for (const [id, { data, from }] of byId) p.contacts.push({ id, data, from });

	if (!tabs.events.missing.length) {
		// Participants are CRM names (n8n writes them): match them to the contacts above by name.
		const byName = new Map<string, string>();
		for (const c of p.contacts) {
			const n = lower(c.data.name);
			if (n && !byName.has(n)) byName.set(n, c.id);
		}
		const seen = new Set<string>();
		for (const r of tabs.events.rows) {
			if (!r['Title']) continue;
			// n8n's own dedupe key: lowercased title + day. The day is normalised, so a change in how
			// the sheet formats dates doesn't turn every meeting into a new one.
			const date = parseDate(r['Date']);
			if (!date) p.skipped.push(`Events: unreadable date "${r['Date']}" for "${r['Title']}"`);
			const day = date ? date.toISOString().slice(0, 10) : `raw:${lower(r['Date'])}`;
			const id = `event-${hash(`${lower(r['Title'])}|${day}`)}`;
			if (seen.has(id)) continue;
			seen.add(id);
			const participants = Array.from({ length: EVENT_PARTICIPANTS }, (_, i) =>
				norm(r[`Participant${i + 1}`])
			)
				.filter(Boolean)
				.map((name) => ({ name, contactId: byName.get(lower(name)) ?? null }));
			p.events.push({
				id,
				data: {
					title: r['Title'],
					type: r['Type'].replace(/^'/, ''),
					date,
					description: r['Description'],
					showInPortal: yes(r['Show in portal']),
					participants,
					contactIds: [
						...new Set(participants.map((x) => x.contactId).filter((x): x is string => !!x))
					]
				}
			});
		}
	}

	if (!tabs.tasks.missing.length) {
		for (const r of tabs.tasks.rows) {
			if (!r['Task']) continue;
			const owner = ownerOf(r['Owner']);
			const status = lower(r['Status']);
			const due = parseDate(r['Due Date']);
			p.tasks.push({
				id: `portal-${hash(r['Task ID'] || r['Task'])}`,
				data: {
					title: r['Task'],
					notes: r['Notes'],
					contactId: null,
					contactName: null,
					assigneeUid: owner?.uid ?? null,
					ownerName: r['Owner'],
					done: status === 'done' || status === 'cancelled',
					cancelled: status === 'cancelled',
					dueAt: due ? new Date(due.getTime() + 11 * 3600_000) : null
				}
			});
		}
	}

	// Health and money only for people who are contacts: test and demo submissions, and the team's
	// own check-ins, must not reach the Hub or the cohort averages.
	// Matched on any of a contact's addresses (a Fellow may fill a form with their other email),
	// and keyed to the contact itself.
	const byEmail = new Map<string, string>();
	for (const c of p.contacts)
		for (const e of [c.data.email, ...((c.data.otherEmails as string[] | undefined) ?? [])])
			if (e && !byEmail.has(String(e))) byEmail.set(String(e), c.id);
	const contactOf = (cell: string) => byEmail.get(primaryEmail(cell));
	const notContacts = { perma: 0, wealth: 0 };

	if (!tabs.perma.missing.length) {
		for (const r of tabs.perma.rows) {
			if (!r['Founder Email']) continue;
			const contactId = contactOf(r['Founder Email']);
			if (!contactId) {
				notContacts.perma++;
				continue;
			}
			const scores = Object.fromEntries(
				['P', 'E', 'R', 'M', 'A', 'N', 'H', 'Loneliness', 'Happiness', 'Overall'].map((k) => [
					k,
					num(r[k])
				])
			);
			p.wellbeing.push({
				id: `perma-${hash(r['Submission ID'] || `${r['Founder Email']}|${r['Completion Date']}`)}`,
				data: {
					contactId,
					completedAt: parseDate(r['Completion Date']),
					scores
				}
			});
		}
	}

	if (!tabs.wealth.missing.length) {
		// Totals in EUR per founder, per report, per row type. Never the line items.
		const totals = new Map<
			string,
			Record<string, Record<string, { gross: number; net: number; value: number }>>
		>();
		for (const r of tabs.wealth.rows) {
			if (!r['Founder Email']) continue;
			const id = contactOf(r['Founder Email']);
			if (!id) {
				notContacts.wealth++;
				continue;
			}
			const report = `${r['Report Type'] || 'Report'} (${r['Completion Date'] || 'no date'})`;
			const t = totals.get(id) ?? {};
			const row = ((t[report] ??= {})[r['Row Type'] || 'Other'] ??= { gross: 0, net: 0, value: 0 });
			row.gross += num(r['Gross EUR']) ?? 0;
			row.net += num(r['Net EUR']) ?? 0;
			row.value += num(r['Value EUR']) ?? 0;
			totals.set(id, t);
		}
		for (const [id, reports] of totals) {
			const existing = p.finance.find((f) => f.id === id);
			if (existing) existing.data.reports = reports;
			else p.finance.push({ id, data: { contactId: id, reports } });
		}
	}
	if (notContacts.perma)
		p.skipped.push(
			`Perma: ${notContacts.perma} rows of people who are not contacts (test, demo, team)`
		);
	if (notContacts.wealth)
		p.skipped.push(`Wealth: ${notContacts.wealth} rows of people who are not contacts`);
	return p;
}

/** The plan's counts, for the dry run and the log. */
export function summary(p: Plan) {
	const stages: Record<string, number> = {};
	for (const c of p.contacts)
		stages[String(c.data.stage)] = (stages[String(c.data.stage)] ?? 0) + 1;
	return {
		contacts: p.contacts.length,
		stages,
		tasks: p.tasks.length,
		wellbeing: p.wellbeing.length,
		finance: p.finance.length,
		events: p.events.length,
		skipped: p.skipped,
		drift: p.drift
	};
}

async function teamList() {
	const snap = await db.collection('user').where('role', 'in', ['user', 'admin']).get();
	return snap.docs.map((d) => ({
		uid: d.id,
		name: String(d.data().name || d.data().email),
		email: String(d.data().email ?? '')
	}));
}

/** Read the sheet and compute the plan; writes nothing. */
export async function dryRun() {
	const p = plan(await readAll(), await teamList());
	return summary(p);
}

/**
 * Move a contact to a new id: its document, its timeline and its tasks. Used once per contact
 * whose id changed with the first-email identity. Returns false when there is nothing to move.
 */
async function moveContact(fromId: string, toId: string): Promise<boolean> {
	const from = crm.contacts.doc(fromId);
	const snap = await from.get();
	if (!snap.exists) return false;
	const to = crm.contacts.doc(toId);
	await to.set(snap.data()!);
	const [activity, taskSnap] = await Promise.all([
		from.collection('activity').get(),
		crm.tasks.where('contactId', '==', fromId).get()
	]);
	let batch = db.batch();
	let n = 0;
	const step = async () => {
		if (++n >= 400) {
			await batch.commit();
			batch = db.batch();
			n = 0;
		}
	};
	for (const a of activity.docs) {
		batch.set(to.collection('activity').doc(a.id), a.data());
		await step();
	}
	for (const t of taskSnap.docs) {
		batch.update(t.ref, { contactId: toId });
		await step();
	}
	await batch.commit();
	await db.recursiveDelete(from);
	logger.log(`moved contact ${fromId} -> ${toId}`);
	return true;
}

/**
 * Read the sheet and upsert everything into the Hub. Contacts keep the Hub's own fields
 * (timeline, tasks, notes, owner once set in the Hub).
 *
 * Stage and next step: whichever changed last wins. The sheet's value is applied only when it
 * differs from what the sheet said at the previous sync (`portal.sheetStage`/`sheetNextStep`),
 * so a move made in the Hub sticks until someone changes that person in the sheet. Automations
 * ignore sync writes (crmContactWritten checks `portal.syncedAt`); new recent meetings ask the
 * owner whether to move the contact (automation `meeting-next-stage`).
 */
export async function run() {
	const tabs = await readAll();
	const p = plan(tabs, await teamList());
	const now = Timestamp.now();
	let created = 0;
	let moved = 0;
	// The events already in the Hub (one read each): only new ones suggest a stage move, and the
	// ones gone from the sheet are removed below.
	const known = new Map(
		(await events.select('contactIds').get()).docs.map((d) => [
			d.id,
			(d.data().contactIds ?? []) as string[]
		])
	);
	// The sheet's own dates per contact: the first and the latest time we know of them (applied,
	// pledged, met). Imports used to stamp the import time instead, which made every contact "new"
	// and none stale.
	const firstSeen = new Map<string, Date>();
	const lastSeen = new Map<string, Date>();
	const seen = (id: string, d: unknown) => {
		if (!(d instanceof Date) || d.getTime() > Date.now()) return;
		const f = firstSeen.get(id);
		if (!f || d < f) firstSeen.set(id, d);
		const l = lastSeen.get(id);
		if (!l || d > l) lastSeen.set(id, d);
	};
	for (const c of p.contacts)
		for (const k of ['appliedAt', 'pledgeDate', 'lastMeeting', 'lastInteraction'])
			seen(c.id, c.data[k]);
	for (const e of p.events) for (const cid of e.data.contactIds) seen(cid, e.data.date);
	const ts = (d: Date | undefined) => (d ? Timestamp.fromDate(d) : null);

	for (const c of p.contacts) {
		const ref = crm.contacts.doc(c.id);
		let doc = await ref.get();
		if (!doc.exists) {
			const legacy = ((c.data.legacyIds as string[] | undefined) ?? []).find((id) => id !== c.id);
			if (legacy && (await moveContact(legacy, c.id))) doc = await ref.get();
		}
		const d = c.data;
		const stage = String(d.stage);
		const portal = {
			from: c.from,
			cohort: d.cohort ?? null,
			pledgeSigned: d.pledgeSigned ?? null,
			pledgeDate: d.pledgeDate ?? null,
			companyUrl: d.companyUrl ?? null,
			location: d.location ?? null,
			sherpaName: d.sherpaName ?? null,
			archetype: d.archetype ?? null,
			funnelStage: d.funnelStage ?? null,
			otherEmails: (d.otherEmails as string[] | undefined)?.length ? d.otherEmails : null,
			onPortal: d.onPortal ?? null,
			contractUrl: d.contractUrl || null,
			reasonsWhy: d.reasonsWhy || null,
			lastInteraction: d.lastInteraction ?? null,
			nextStep: d.nextStep || null,
			sheetStage: stage,
			sheetNextStep: nextStepFromSheet(String(d.nextStep ?? '')),
			scoring: d.scoring || null,
			reasonLost: d.reasonLost || null,
			sheetNotes: d.sheetNotes || null,
			syncedAt: now
		};
		const final = stage === 'fellow' || stage === 'lost';
		if (!doc.exists) {
			await ref.set({
				type: 'fellow',
				name: d.name,
				email: d.email ?? '',
				phone: '',
				company: d.company ?? '',
				linkedin: d.linkedin ?? '',
				source: 'portal',
				stage,
				nextStep: portal.sheetNextStep,
				open: !final,
				ownerUid: d.ownerUid ?? null,
				ownerName: d.ownerName ?? null,
				tags: d.cohort ? [`cohort-${d.cohort}`] : [],
				notes: '',
				needsAttention: false,
				portal,
				stageChangedAt: now,
				lastActivityAt: ts(lastSeen.get(c.id)) ?? now,
				createdAt: ts(firstSeen.get(c.id)) ?? now,
				sheetDates: true,
				updatedAt: now,
				createdBy: 'portal-sync'
			});
			await ref.collection('activity').add({
				kind: 'created',
				text: `Imported from the portal sheet (${c.from})`,
				by: 'Portal sync',
				via: 'portal',
				at: now
			});
			created++;
			continue;
		}
		const cur = doc.data() as crm.Contact;
		const update: Record<string, unknown> = {
			name: d.name,
			company: d.company || cur.company,
			linkedin: d.linkedin || cur.linkedin,
			portal,
			updatedAt: now
		};
		if (!cur.ownerUid && d.ownerUid)
			Object.assign(update, { ownerUid: d.ownerUid, ownerName: d.ownerName });
		// Once per contact imported before the sheet's dates were used: its real creation date, and
		// its last activity from the sheet unless the Hub has a later one (one read, once).
		const firstPass =
			cur.createdBy === 'portal-sync' && !(cur as { sheetDates?: boolean }).sheetDates;
		if (firstPass) {
			const hub = await ref.collection('activity').orderBy('at', 'desc').limit(20).get();
			const hubLast = hub.docs.find((a) => a.data().via !== 'portal')?.data().at as
				FirebaseFirestore.Timestamp | undefined;
			const sheetLast = ts(lastSeen.get(c.id));
			const last = [hubLast, sheetLast]
				.filter((x): x is FirebaseFirestore.Timestamp => !!x)
				.sort((a, b) => b.toMillis() - a.toMillis())[0];
			Object.assign(update, {
				sheetDates: true,
				...(firstSeen.has(c.id) ? { createdAt: ts(firstSeen.get(c.id)) } : {}),
				...(last ? { lastActivityAt: last } : {})
			});
		}
		// Only when the sheet changed since the last sync: otherwise a Hub move stands.
		if (cur.stage !== stage && cur.portal?.sheetStage !== stage) {
			const label = (s: string) => stageOf(cur.type, s)?.label ?? s;
			// The Hub's loss reason belongs to the stage it was given for.
			Object.assign(update, { stage, open: !final, stageChangedAt: now, lostReason: '' });
			await ref.collection('activity').add({
				kind: 'stage',
				text: `${label(cur.stage)} → ${label(stage)} (from the portal sheet)`,
				by: 'Portal sync',
				via: 'portal',
				from: cur.stage,
				to: stage,
				at: now
			});
			// Sync writes skip crmContactWritten, so close the old stage's tasks here, as a Hub move does.
			await crm.closeAutomationTasks(c.id, [
				'stage-follow-up',
				'meeting-next-stage',
				'stale-contacts'
			]);
			moved++;
		}
		const sheetNext = portal.sheetNextStep;
		if ((cur.nextStep ?? '') !== sheetNext && cur.portal?.sheetNextStep !== sheetNext) {
			update.nextStep = sheetNext;
			await ref.collection('activity').add({
				kind: 'updated',
				text: `Next step: ${nextStepOf(sheetNext)?.label ?? 'none'} (from the portal sheet)`,
				by: 'Portal sync',
				via: 'portal',
				at: now
			});
		}
		await ref.update(update);
		// A new owner takes the contact's automation tasks. On the first pass this also repairs tasks
		// left with whoever moved the contact before an owner was set by hand (handover came later).
		const owner = (update.ownerUid as string | undefined) ?? (firstPass ? cur.ownerUid : null);
		if (owner) await crm.handOverTasks(c.id, owner);
	}

	const batch = () => db.batch();
	let b = batch();
	let n = 0;
	const flush = async () => {
		if (n) await b.commit();
		b = batch();
		n = 0;
	};
	for (const t of p.tasks) {
		b.set(crm.tasks.doc(t.id), { ...t.data, source: 'portal', syncedAt: now }, { merge: true });
		if (++n >= 400) await flush();
	}
	for (const w of p.wellbeing) {
		b.set(wellbeing.doc(w.id), { ...w.data, syncedAt: now });
		if (++n >= 400) await flush();
	}
	for (const f of p.finance) {
		b.set(finance.doc(f.id), { ...f.data, syncedAt: now }, { merge: true });
		if (++n >= 400) await flush();
	}
	// Health and money no longer in the sheet (or no longer a contact's) are removed, so they leave
	// the cohort averages too. Only after a whole, unchanged read of their tabs. One read per doc.
	const whole = (k: TabKey) => !tabs[k].missing.length && !tabs[k].truncated;
	let removedHealth = 0;
	// Who is a contact comes from these tabs: a partial read of any of them would make real Fellows
	// look like strangers, and their data would be deleted.
	const contactsWhole = (['crm', 'profiles', 'applications'] as TabKey[]).every(whole);
	if (contactsWhole && whole('perma')) {
		const keep = new Set(p.wellbeing.map((w) => w.id));
		for (const d of (await wellbeing.select().get()).docs)
			if (!keep.has(d.id)) {
				b.delete(d.ref);
				removedHealth++;
				if (++n >= 400) await flush();
			}
	}
	if (contactsWhole && whole('wealth')) {
		const keep = new Set(p.finance.map((f) => f.id));
		for (const d of (await finance.select().get()).docs)
			if (!keep.has(d.id)) {
				b.delete(d.ref);
				removedHealth++;
				if (++n >= 400) await flush();
			}
	}
	// Meetings, and one timeline entry per contact per meeting (doc id = event id, so a second
	// run rewrites it instead of adding another).
	const newMeetings: { contactId: string; title: string; date: Date | null }[] = [];
	for (const e of p.events) {
		if (!known.has(e.id))
			for (const cid of e.data.contactIds)
				newMeetings.push({ contactId: cid, title: e.data.title, date: e.data.date });
		b.set(events.doc(e.id), { ...e.data, syncedAt: now });
		if (++n >= 400) await flush();
		const at = e.data.date ? Timestamp.fromDate(e.data.date) : now;
		for (const cid of e.data.contactIds) {
			b.set(crm.contacts.doc(cid).collection('activity').doc(e.id), {
				kind: 'meeting',
				text: e.data.type ? `${e.data.type}: ${e.data.title}` : e.data.title,
				by: 'Calendar',
				via: 'portal',
				at
			});
			if (++n >= 400) await flush();
		}
	}
	// Events deleted or renamed in the sheet: remove them and their timeline entries. Only when the
	// Events tab was read whole (no missing columns), never on a partial read.
	let removedEvents = 0;
	if (!p.drift[TABS.events.name] && !p.truncated.includes('events')) {
		const current = new Set(p.events.map((e) => e.id));
		const nowIn = new Map(p.events.map((e) => [e.id, new Set(e.data.contactIds as string[])]));
		for (const [id, contactIds] of known) {
			if (current.has(id)) {
				// Kept meeting: drop it from the timelines of people no longer listed on it.
				for (const cid of contactIds) {
					if (nowIn.get(id)?.has(cid)) continue;
					b.delete(crm.contacts.doc(cid).collection('activity').doc(id));
					if (++n >= 400) await flush();
				}
				continue;
			}
			b.delete(events.doc(id));
			if (++n >= 400) await flush();
			for (const cid of contactIds) {
				b.delete(crm.contacts.doc(cid).collection('activity').doc(id));
				if (++n >= 400) await flush();
			}
			removedEvents++;
		}
	}
	await flush();

	// A meeting is activity: move each contact's lastActivityAt forward to its latest meeting, so
	// someone met yesterday is not flagged stale. One read per contact with meetings.
	// The sheet's "Last Meeting" and "Last Interaction" count too.
	const latest = lastSeen;
	const metContacts: string[] = [];
	for (const [cid, date] of latest) {
		const ref = crm.contacts.doc(cid);
		const cur = (await ref.get()).data();
		if (!cur) continue;
		const last = cur.lastActivityAt?.toMillis?.() ?? 0;
		if (last >= date.getTime()) continue;
		// A meeting is activity: it also clears "needs attention".
		b.update(ref, { lastActivityAt: Timestamp.fromDate(date), needsAttention: false });
		if (++n >= 400) await flush();
		metContacts.push(cid);
	}
	await flush();

	// A new meeting answers "no activity": close the check-in tasks it made obsolete.
	for (const cid of metContacts) await crm.closeAutomationTasks(cid, ['stale-contacts']);

	const { meetingSuggestions } = await import('../automations/index.js');
	await meetingSuggestions(newMeetings);

	const result = {
		...summary(p),
		created,
		moved,
		newMeetings: newMeetings.length,
		removedEvents,
		removedHealthOrFinance: removedHealth
	};
	await connectionCollection.doc('portal-sheet').set(
		{
			lastSyncAt: serverTimestamp(),
			lastSync: {
				created,
				moved,
				contacts: p.contacts.length,
				tasks: p.tasks.length,
				events: p.events.length,
				skipped: p.skipped
			}
		},
		{ merge: true }
	);
	logger.log(
		`sync ${JSON.stringify({ created, moved, contacts: p.contacts.length, tasks: p.tasks.length })}`
	);
	return result;
}

/** One contact's wellbeing history (PERMA). Never served to Claude. */
export async function wellbeingOf(contactId: string) {
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(contactId))
		throw new HttpsError('invalid-argument', 'Invalid id.');
	const snap = await wellbeing
		.where('contactId', '==', contactId)
		.orderBy('completedAt', 'desc')
		.limit(24)
		.get();
	return snap.docs.map((d) => ({
		completedAt: d.data().completedAt?.toMillis?.() ?? null,
		scores: d.data().scores
	}));
}

/** Cohort averages of the latest PERMA per Fellow: no individual answers. */
export async function wellbeingSummary() {
	const snap = await wellbeing.orderBy('completedAt', 'desc').limit(1000).get();
	const latest = new Map<string, Record<string, number | null>>();
	for (const d of snap.docs)
		if (!latest.has(d.data().contactId)) latest.set(d.data().contactId, d.data().scores);
	const keys = ['P', 'E', 'R', 'M', 'A', 'N', 'H', 'Loneliness', 'Happiness', 'Overall'];
	const avg = Object.fromEntries(
		keys.map((k) => {
			const v = [...latest.values()]
				.map((s) => s[k])
				.filter((x): x is number => typeof x === 'number');
			return [k, v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null];
		})
	);
	return { fellows: latest.size, responses: snap.size, average: avg };
}

/** One Fellow's financial summary (income and report totals). Never served to Claude. */
export async function financeOf(contactId: string) {
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(contactId))
		throw new HttpsError('invalid-argument', 'Invalid id.');
	const d = (await finance.doc(contactId).get()).data();
	return d ? { ...d, syncedAt: d.syncedAt?.toMillis?.() ?? null } : null;
}
