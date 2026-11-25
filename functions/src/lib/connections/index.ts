import { HttpsError } from 'firebase-functions/v2/https';
import { GoogleAuth } from 'google-auth-library';
import { readFileSync } from 'fs';
import { db } from '../../firestore';
import { useEmulator } from '../../env';
import { serverTimestamp, str, createLogger } from '../utils';
import { CATEGORIES, CONNECTORS, connector } from './config';
import { CONNECTION_COLLECTION, CONNECTOR_URL } from '../mcp/config';
import { N8N_AUTOMATIONS } from '../automations/config';

const logger = createLogger('connections');
export const collection = db.collection('connection');

export type Status = 'ok' | 'error' | 'not_configured' | 'planned';

export interface ConnectionState {
	settings?: Record<string, string>;
	status?: Status;
	lastCheckAt?: FirebaseFirestore.Timestamp;
	lastError?: string | null;
	lastEventAt?: FirebaseFirestore.Timestamp;
	lastSyncAt?: FirebaseFirestore.Timestamp;
	detail?: string;
}

/** Secrets a check may use, passed in by the dispatcher that holds them. */
export interface Secrets {
	checklyApiKey?: string;
	n8nApiKey?: string;
}

/** `Name | id` lines of a list setting. */
function pairs(value: string | undefined) {
	return (value ?? '')
		.split('\n')
		.map((line) => line.split('|').map((x) => x.trim()))
		.filter((p) => p.length === 2 && p[0] && p[1])
		.map(([name, id]) => ({ name, id }));
}

/** GET with a timeout; never anything but GET. */
async function get(url: string, headers: Record<string, string> = {}, ms = 15_000) {
	return fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(ms) });
}

async function settingsOf(id: string): Promise<Record<string, string>> {
	return ((await collection.doc(id).get()).data()?.settings as Record<string, string>) ?? {};
}

/** One n8n workflow as the Automations page shows it. */
export interface N8nWorkflow {
	id: string;
	name: string;
	active: boolean;
	updatedAt: string | null;
	tags: string[];
	/** Latest saved run; null when n8n kept none. */
	lastRun: { at: string | null; status: string } | null;
	errors24h: number;
	lastErrorAt: string | null;
	url: string;
}

/**
 * FLF's workflows of the n8n instance (the instance also holds other companies' workflows, which
 * the Hub never shows), with their latest run and their failures of the last 24 h.
 * Read only (GET /workflows and /executions): never runs, edits or publishes anything.
 * About three requests, plus one per FLF workflow for its own latest run.
 */
export async function n8nWorkflows(apiKey: string | undefined): Promise<N8nWorkflow[]> {
	const settings = await settingsOf('n8n');
	if (!apiKey || !settings.baseUrl)
		throw new HttpsError(
			'failed-precondition',
			'Set up the n8n connection first (Connections → n8n workflows).'
		);
	const base = settings.baseUrl.replace(/\/+$/, '');
	const headers = { 'X-N8N-API-KEY': apiKey, Accept: 'application/json' };
	const page = async <T>(path: string, max: number): Promise<T[]> => {
		const out: T[] = [];
		let cursor = '';
		while (out.length < max) {
			const sep = path.includes('?') ? '&' : '?';
			const res = await get(
				`${base}/api/v1/${path}${sep}limit=${Math.min(250, max - out.length)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
				headers
			);
			if (!res.ok)
				throw new HttpsError(
					'unavailable',
					`n8n returned an error (${res.status}). Test the n8n connection on Connections.`
				);
			const body = (await res.json()) as { data?: T[]; nextCursor?: string | null };
			out.push(...(body.data ?? []));
			if (!body.nextCursor) break;
			cursor = body.nextCursor;
		}
		return out;
	};
	type Wf = {
		id: string;
		name: string;
		active: boolean;
		updatedAt?: string;
		tags?: { name: string }[];
	};
	type Ex = { workflowId: string; status?: string; startedAt?: string };
	const [all, errors] = await Promise.all([
		page<Wf>('workflows', 1000),
		page<Ex>('executions?status=error', 250)
	]);
	const last = new Map<string, Ex>();
	const since = new Date(Date.now() - 24 * 3600_000).toISOString();
	const flfIds = new Set([
		...pairs(settings.workflows).map((w) => w.id),
		...N8N_AUTOMATIONS.map((a) => a.workflowId)
	]);
	const isFlf = (w: Wf) => flfIds.has(w.id) || /\b(FLF|FFL)\b/i.test(w.name);
	const workflows = all.filter(isFlf);
	// Each workflow's own latest run, whatever the rest of the instance did since.
	await Promise.all(
		workflows.map(async (w) => {
			const [run] = await page<Ex>(`executions?workflowId=${encodeURIComponent(w.id)}`, 1);
			if (run) last.set(w.id, run);
		})
	);
	return workflows
		.map((w) => {
			const mine = errors.filter((e) => e.workflowId === w.id);
			const run = last.get(w.id);
			return {
				id: w.id,
				name: w.name,
				active: w.active,
				updatedAt: w.updatedAt ?? null,
				tags: (w.tags ?? []).map((t) => t.name),
				lastRun: run ? { at: run.startedAt ?? null, status: run.status ?? 'unknown' } : null,
				errors24h: mine.filter((e) => (e.startedAt ?? '') >= since).length,
				lastErrorAt:
					mine
						.map((e) => e.startedAt ?? '')
						.sort()
						.at(-1) || null,
				url: `${base}/workflow/${w.id}`
			};
		})
		.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}

/** A range's values. Read-only scope: the Hub never writes to a sheet. */
export async function readSheet(spreadsheetId: string, range: string): Promise<string[][]> {
	// Emulator only: a local JSON file stands in for Google (no credentials locally).
	if (useEmulator && process.env.SHEETS_FIXTURE) {
		const fixture = JSON.parse(readFileSync(process.env.SHEETS_FIXTURE, 'utf8')) as Record<
			string,
			string[][]
		>;
		return fixture[range.replace(/^'|'$/g, '')] ?? [];
	}
	const auth = new GoogleAuth({
		scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
	});
	const client = await auth.getClient();
	const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
	const res = await client.request<{ values?: string[][] }>({ url });
	return res.data.values ?? [];
}

/** Check one connection for real and return what to record. Never throws. */
async function check(id: string, secrets: Secrets): Promise<{ status: Status; detail: string }> {
	const c = connector(id);
	if (!c) return { status: 'error', detail: 'Unknown connection.' };
	if (c.availability === 'planned') return { status: 'planned', detail: 'Not built yet.' };
	const settings = await settingsOf(id);
	try {
		switch (id) {
			case 'portal-sheet': {
				// Lazy: portal imports this module.
				const portal = await import('../portal/index.js');
				const tabs = await portal.readAll();
				const drift = Object.entries(tabs)
					.filter(([, t]) => t.missing.length)
					.map(([k, t]) => `${k}: missing ${t.missing.join(', ')}`);
				const rows = Object.entries(tabs)
					.map(([k, t]) => `${k} ${t.rows.length}`)
					.join(' · ');
				if (drift.length)
					return { status: 'error', detail: `The sheet's columns changed: ${drift.join('; ')}` };
				return { status: 'ok', detail: `All columns found. Rows: ${rows}` };
			}
			case 'checkly': {
				if (!secrets.checklyApiKey || !settings.accountId) {
					return {
						status: 'not_configured',
						detail: 'CHECKLY_API_KEY and the account id are needed.'
					};
				}
				const res = await get('https://api.checklyhq.com/v1/check-statuses', {
					Authorization: `Bearer ${secrets.checklyApiKey}`,
					'X-Checkly-Account': settings.accountId
				});
				if (!res.ok) return { status: 'error', detail: `Checkly answered ${res.status}.` };
				const checks = (await res.json()) as {
					name: string;
					hasFailures: boolean;
					hasErrors: boolean;
				}[];
				if (!checks.length)
					return { status: 'not_configured', detail: 'No checks in Checkly yet.' };
				const failing = checks.filter((c) => c.hasFailures || c.hasErrors).map((c) => c.name);
				return failing.length
					? { status: 'error', detail: `Failing: ${failing.join(', ')}` }
					: { status: 'ok', detail: `${checks.length} checks passing.` };
			}
			case 'n8n': {
				const list = pairs(settings.workflows);
				if (!secrets.n8nApiKey || !settings.baseUrl || !list.length) {
					return {
						status: 'not_configured',
						detail: 'Needs the n8n address, the workflows and an API key (developer).'
					};
				}
				const base = settings.baseUrl.replace(/\/+$/, '');
				const since = Date.now() - 24 * 3600_000;
				const lines: string[] = [];
				let failed = false;
				for (const w of list) {
					// Read only: the executions list. Never /run, /activate or a webhook.
					const res = await get(
						`${base}/api/v1/executions?workflowId=${encodeURIComponent(w.id)}&limit=20`,
						{ 'X-N8N-API-KEY': secrets.n8nApiKey, Accept: 'application/json' }
					);
					if (!res.ok) {
						failed = true;
						lines.push(`${w.name}: n8n answered ${res.status}`);
						continue;
					}
					const runs =
						((await res.json()) as { data?: { status?: string; startedAt?: string }[] }).data ?? [];
					const recent = runs.filter((r) => Date.parse(r.startedAt ?? '') >= since);
					const errors = recent.filter(
						(r) => r.status === 'error' || r.status === 'crashed'
					).length;
					if (errors) failed = true;
					// Some workflows don't save successful runs (FFL Google Sheets), so only failures count.
					lines.push(`${w.name}: ${errors} failed in 24 h`);
				}
				return { status: failed ? 'error' : 'ok', detail: lines.join(' · ') };
			}
			case 'knowledge-folder': {
				// Lazy: knowledge is not needed by the other checks.
				const knowledge = await import('../knowledge/index.js');
				const { files, unshared } = await knowledge.listFolder();
				if (unshared.length)
					return {
						status: 'error',
						detail: `Shortcuts to folders the Hub can't open (share them with 900685987021-compute@developer.gserviceaccount.com as Viewer): ${unshared.join(', ')}.`
					};
				const readable = files.filter((f) =>
					[
						'application/vnd.google-apps.document',
						'text/plain',
						'text/markdown',
						'text/x-markdown'
					].includes(f.mimeType)
				).length;
				return {
					status: 'ok',
					detail: `${files.length} files in the folder and its subfolders, ${readable} importable (Google Docs, text, Markdown).`
				};
			}
			case 'claude-connector': {
				if (!CONNECTOR_URL) {
					return {
						status: 'not_configured',
						detail: 'Not set up yet: a developer needs to finish setup.'
					};
				}
				// Working means the server answers from outside and someone has connected Claude.
				const meta = await get(
					`${new URL(CONNECTOR_URL).origin}/.well-known/oauth-protected-resource`
				);
				if (!meta.ok)
					return {
						status: 'error',
						detail: `The connector answered ${meta.status} · ${CONNECTOR_URL}`
					};
				const n = (
					await db.collection(CONNECTION_COLLECTION).where('endsAt', '>', new Date()).count().get()
				).data().count;
				if (!n)
					return {
						status: 'not_configured',
						detail: `Ready, but nobody has connected Claude yet (Claude page) · ${CONNECTOR_URL}`
					};
				return {
					status: 'ok',
					detail: `${n} active connection${n === 1 ? '' : 's'} · ${CONNECTOR_URL}`
				};
			}
		}
		return { status: 'error', detail: 'No check for this connection.' };
	} catch (err) {
		return { status: 'error', detail: err instanceof Error ? err.message : String(err) };
	}
}

/** Run a check and store the result on the connection's document. */
export async function test(id: string, secrets: Secrets) {
	const result = await check(id, secrets);
	await collection.doc(id).set(
		{
			status: result.status,
			detail: result.detail,
			lastCheckAt: serverTimestamp(),
			lastError: result.status === 'error' ? result.detail : null
		},
		{ merge: true }
	);
	return result;
}

/** Check every live connection. Used by the hourly health cron. */
export async function testAll(secrets: Secrets) {
	for (const c of CONNECTORS) {
		const result = await test(c.id, secrets);
		if (result.status === 'error') logger.warn(`${c.id}: ${result.detail}`);
	}
}

export function actionsWith(secrets: () => Secrets) {
	return {
		'config.get': async () => ({ connectors: CONNECTORS, categories: CATEGORIES }),

		'settings.save': async (p: any) => {
			const id = str(p.id, 'id');
			const c = connector(id);
			if (!c) throw new HttpsError('not-found', 'Unknown connection.');
			const settings: Record<string, string> = {};
			for (const f of c.settings) settings[f.key] = str(p.settings?.[f.key], f.key, false);
			await collection.doc(id).set({ settings }, { merge: true });
			return { ok: true };
		},

		test: async (p: any) => test(str(p.id, 'id'), secrets())
	};
}
