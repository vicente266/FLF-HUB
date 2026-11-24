import { HttpsError } from 'firebase-functions/v2/https';
import { BigQuery } from '@google-cloud/bigquery';
import { GoogleAuth } from 'google-auth-library';
import { db } from '../../firestore';
import { serverTimestamp, str, createLogger } from '../utils';
import { CATEGORIES, CONNECTORS, connector } from './config';

const logger = createLogger('connections');
export const collection = db.collection('connection');
export const snapshots = db.collection('sheetSnapshot');

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
	slackWebhookUrl?: string;
	leadWebhookToken?: string;
}

async function settingsOf(id: string): Promise<Record<string, string>> {
	return ((await collection.doc(id).get()).data()?.settings as Record<string, string>) ?? {};
}

/** `Name | id | range` lines of the Google Sheets settings. */
export function sheetSources(settings: Record<string, string>) {
	return (settings.sources ?? '')
		.split('\n')
		.map((line) => line.split('|').map((s) => s.trim()))
		.filter((parts) => parts.length === 3 && parts.every(Boolean))
		.map(([name, spreadsheetId, range]) => ({ name, spreadsheetId, range }));
}

async function readSheet(spreadsheetId: string, range: string): Promise<string[][]> {
	const auth = new GoogleAuth({
		scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
	});
	const client = await auth.getClient();
	const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
	const res = await client.request<{ values?: string[][] }>({ url });
	return res.data.values ?? [];
}

/** Post one message to the team channel. Silently skipped when Slack is not set up. */
export async function slack(webhookUrl: string | undefined, text: string): Promise<boolean> {
	if (!webhookUrl) return false;
	const res = await fetch(webhookUrl, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ text })
	});
	if (!res.ok) throw new Error(`Slack answered ${res.status}`);
	return true;
}

/** Check one connection for real and return what to record. Never throws. */
async function check(
	id: string,
	secrets: Secrets,
	manual: boolean
): Promise<{ status: Status; detail: string }> {
	const c = connector(id);
	if (!c) return { status: 'error', detail: 'Unknown connection.' };
	if (c.availability === 'planned') return { status: 'planned', detail: 'Not built yet.' };
	const settings = await settingsOf(id);
	try {
		switch (id) {
			case 'website-forms': {
				if (!secrets.leadWebhookToken)
					return { status: 'not_configured', detail: 'LEAD_WEBHOOK_TOKEN is not set.' };
				const last = (await collection.doc(id).get()).data()?.lastEventAt;
				return {
					status: 'ok',
					detail: last
						? 'Token set; applications are arriving.'
						: 'Token set; no application received yet.'
				};
			}
			case 'google-sheets': {
				const sources = sheetSources(settings);
				if (!sources.length) return { status: 'not_configured', detail: 'No sheet configured.' };
				const counts = [];
				for (const s of sources)
					counts.push(`${s.name}: ${(await readSheet(s.spreadsheetId, s.range)).length} rows`);
				return { status: 'ok', detail: counts.join(' · ') };
			}
			case 'bigquery': {
				if (!settings.projectId || !settings.dataset)
					return { status: 'not_configured', detail: 'Project id and dataset are required.' };
				const bq = new BigQuery({ projectId: settings.projectId });
				const [tables] = await bq.dataset(settings.dataset).getTables();
				return { status: 'ok', detail: `${tables.length} tables in ${settings.dataset}.` };
			}
			case 'slack': {
				if (!secrets.slackWebhookUrl)
					return { status: 'not_configured', detail: 'SLACK_WEBHOOK_URL is not set.' };
				// Only a test someone pressed posts; the hourly check would spam the channel.
				if (!manual) return { status: 'ok', detail: 'Webhook URL set.' };
				await slack(secrets.slackWebhookUrl, 'FLF Hub: connection test ✅');
				return { status: 'ok', detail: 'Test message sent.' };
			}
		}
		return { status: 'error', detail: 'No check for this connection.' };
	} catch (err) {
		return { status: 'error', detail: err instanceof Error ? err.message : String(err) };
	}
}

/** Run a check and store the result on the connection's document. */
export async function test(id: string, secrets: Secrets, manual = true) {
	const result = await check(id, secrets, manual);
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
		const result = await test(c.id, secrets, false);
		if (result.status === 'error') logger.warn(`${c.id}: ${result.detail}`);
	}
}

/** Copy every configured sheet into `sheetSnapshot/{name}` for Reports. */
export async function syncSheets(): Promise<number> {
	const sources = sheetSources(await settingsOf('google-sheets'));
	for (const s of sources) {
		const rows = await readSheet(s.spreadsheetId, s.range);
		// Firestore has no nested arrays: one map per row, keyed by column index.
		await snapshots.doc(s.name).set({
			name: s.name,
			header: rows[0] ?? [],
			rows: rows.slice(1, 1000).map((r) => Object.fromEntries(r.map((v, i) => [String(i), v]))),
			syncedAt: serverTimestamp()
		});
	}
	await collection.doc('google-sheets').set({ lastSyncAt: serverTimestamp() }, { merge: true });
	return sources.length;
}

/** Record that an inbound event arrived (website application). */
export async function touchEvent(id: string) {
	await collection.doc(id).set({ lastEventAt: serverTimestamp() }, { merge: true });
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

		test: async (p: any) => test(str(p.id, 'id'), secrets()),

		'sheets.sync': async () => ({ synced: await syncSheets() })
	};
}
