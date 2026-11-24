import { createHash } from 'crypto';
import { HttpsError } from 'firebase-functions/v2/https';
import { db } from '../../firestore';
import { createLogger, serverTimestamp, Timestamp } from '../utils';
import * as crm from '../crm/index';
import { readSheet, collection as connectionCollection } from '../connections/index';
import { DEFAULT_SPREADSHEET_ID, MAX_ROWS, STAGE_MAP, TABS, type TabKey } from './config';

/**
 * Read-only import of the FLF Portal sheet into the Hub (docs/portal-import.md). The sheet stays
 * the portal's live database: the import reads it, never writes it, and can be run again at any
 * time (it upserts by a stable id). While the portal is live the sheet wins for the fields it
 * owns; the Hub keeps its own timeline, tasks and owner.
 */

const logger = createLogger('portal');
export const wellbeing = db.collection('wellbeing');
export const finance = db.collection('fellowFinance');

/** One tab, as header → value objects, and the headers it is missing. */
export interface Tab {
	rows: Record<string, string>[];
	missing: string[];
}

const norm = (s: unknown) => String(s ?? '').trim();
const lower = (s: unknown) => norm(s).toLowerCase();
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);

/** The Hub id of a person from the sheet: by email, or by name when there is none. */
export function contactIdOf(email: string, name: string): string {
	const key = lower(email) || `name:${lower(name)}`;
	return `portal-${hash(key)}`;
}

/** Rows as objects keyed by header, keeping only the configured columns. */
export function toTab(values: string[][], columns: readonly string[]): Tab {
	const header = (values[0] ?? []).map(norm);
	const missing = columns.filter((c) => !header.includes(c));
	const index = new Map(columns.map((c) => [c, header.indexOf(c)]));
	const rows = values
		.slice(1, MAX_ROWS + 1)
		.map((r) =>
			Object.fromEntries(columns.map((c) => [c, index.get(c)! >= 0 ? norm(r[index.get(c)!]) : '']))
		)
		.filter((r) => Object.values(r).some(Boolean));
	return { rows, missing };
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
	skipped: string[];
	drift: Record<string, string[]>;
}

/**
 * The plan, from the tabs. Pure: no reads or writes, so it is what the dry run shows and what the
 * tests exercise. Precedence for a person: CRM tab (stage) > Profiles (a Fellow) > Applications.
 */
export function plan(tabs: Record<TabKey, Tab>, team: { uid: string; name: string }[]): Plan {
	const p: Plan = { contacts: [], tasks: [], wellbeing: [], finance: [], skipped: [], drift: {} };
	for (const [k, t] of Object.entries(tabs))
		if (t.missing.length) p.drift[TABS[k as TabKey].name] = t.missing;

	const byId = new Map<string, { data: Record<string, unknown>; from: string }>();
	const put = (id: string, data: Record<string, unknown>, from: string) => {
		const prev = byId.get(id);
		// Earlier sources win the stage; later ones only fill fields still empty.
		if (!prev) byId.set(id, { data, from });
		else {
			for (const [k, v] of Object.entries(data)) {
				if (prev.data[k] === undefined || prev.data[k] === '' || prev.data[k] === null)
					prev.data[k] = v;
			}
			prev.from = `${prev.from}+${from}`;
		}
	};
	const ownerOf = (name: string) => {
		const n = lower(name);
		if (!n) return null;
		return team.find((u) => lower(u.name) === n || lower(u.name).split(' ')[0] === n) ?? null;
	};

	if (!tabs.crm.missing.length) {
		for (const r of tabs.crm.rows) {
			if (!r['Name'] && !r['Email']) continue;
			const stage = STAGE_MAP[lower(r['Stage'])];
			if (!stage) {
				p.skipped.push(`CRM: unknown stage "${r['Stage']}"`);
				continue;
			}
			put(
				contactIdOf(r['Email'], r['Name']),
				{
					name: r['Name'] || r['Email'],
					email: lower(r['Email']),
					company: r['Company Name'],
					stage,
					nextStep: r['Status'],
					scoring: r['Scoring'],
					reasonLost: r['Reason Lost'],
					sheetNotes: r['Notes']
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
					name: r['Name'] || r['Email'],
					email: lower(r['Email']),
					company: r['Company Name'],
					linkedin: r['LinkedIn'],
					stage: 'fellow',
					cohort: r['Cohort'],
					pledgeSigned: yes(r['Pledge Signed']),
					pledgeDate: parseDate(r['Pledge Date']),
					companyUrl: r['Company URL'],
					location: r['Location'],
					sherpaName: r['Sherpa Name'],
					archetype: r['Archetype'],
					funnelStage: r['Funnel Stage'],
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
			put(
				contactIdOf(r['Email'], r['Name']),
				{
					name: r['Name'] || r['Email'],
					email: lower(r['Email']),
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

	if (!tabs.perma.missing.length) {
		for (const r of tabs.perma.rows) {
			if (!r['Founder Email']) continue;
			const scores = Object.fromEntries(
				['P', 'E', 'R', 'M', 'A', 'N', 'H', 'Loneliness', 'Happiness', 'Overall'].map((k) => [
					k,
					num(r[k])
				])
			);
			p.wellbeing.push({
				id: `perma-${hash(r['Submission ID'] || `${r['Founder Email']}|${r['Completion Date']}`)}`,
				data: {
					contactId: contactIdOf(r['Founder Email'], ''),
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
			const id = contactIdOf(r['Founder Email'], '');
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
		skipped: p.skipped,
		drift: p.drift
	};
}

async function teamList() {
	const snap = await db.collection('user').where('role', 'in', ['user', 'admin']).get();
	return snap.docs.map((d) => ({ uid: d.id, name: String(d.data().name || d.data().email) }));
}

/** Read the sheet and compute the plan; writes nothing. */
export async function dryRun() {
	const p = plan(await readAll(), await teamList());
	return summary(p);
}

/**
 * Read the sheet and upsert everything into the Hub. Contacts keep the Hub's own fields
 * (timeline, tasks, notes, owner once set in the Hub); a stage that changed in the sheet is
 * recorded on the timeline as "via portal sync". Automations ignore sync writes (crmContactWritten
 * checks `portal.syncedAt`).
 */
export async function run() {
	const p = plan(await readAll(), await teamList());
	const now = Timestamp.now();
	let created = 0;
	let moved = 0;
	for (const c of p.contacts) {
		const ref = crm.contacts.doc(c.id);
		const doc = await ref.get();
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
			nextStep: d.nextStep || null,
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
				open: !final,
				ownerUid: d.ownerUid ?? null,
				ownerName: d.ownerName ?? null,
				tags: d.cohort ? [`cohort-${d.cohort}`] : [],
				notes: '',
				needsAttention: false,
				portal,
				stageChangedAt: now,
				lastActivityAt: now,
				createdAt: d.appliedAt ?? now,
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
		if (cur.stage !== stage) {
			Object.assign(update, { stage, open: !final, stageChangedAt: now });
			await ref.collection('activity').add({
				kind: 'stage',
				text: `${cur.stage} → ${stage} (from the portal sheet)`,
				by: 'Portal sync',
				via: 'portal',
				from: cur.stage,
				to: stage,
				at: now
			});
			moved++;
		}
		await ref.update(update);
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
	await flush();

	const result = { ...summary(p), created, moved };
	await connectionCollection.doc('portal-sheet').set(
		{
			lastSyncAt: serverTimestamp(),
			lastSync: { created, moved, contacts: p.contacts.length, tasks: p.tasks.length }
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
