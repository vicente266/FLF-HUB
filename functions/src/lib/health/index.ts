import { CONNECTORS } from '../connections/config';
import * as connections from '../connections/index';
import { AUTOMATIONS } from '../automations/config';
import * as automations from '../automations/index';

export type Level = 'ok' | 'warning' | 'error' | 'off';

const ms = (t: any) => (t?.toMillis ? t.toMillis() : null);
const HOUR = 3600_000;
/** Connections are checked hourly: a check older than this means the hourly job stopped. */
const CHECK_STALE = 3 * HOUR;
/** Daily automations: a last run older than this means the schedule stopped. */
const RUN_STALE = 48 * HOUR;
const stale = (checked: number | null) => !!checked && Date.now() - checked > CHECK_STALE;

/**
 * Everything that can break, in one list: each connection's last check, each automation's last
 * run. Reads one document per connection and automation.
 */
export async function get() {
	const [conns, autos] = await Promise.all([
		connections.collection.get(),
		automations.collection.get()
	]);
	const connState = new Map(conns.docs.map((d) => [d.id, d.data()]));
	const autoState = new Map(autos.docs.map((d) => [d.id, d.data()]));

	const connectionRows = CONNECTORS.map((c) => {
		const s = connState.get(c.id) ?? {};
		let level: Level = 'off';
		const checked = ms(s.lastCheckAt);
		const old = c.availability === 'live' && stale(checked);
		// What to do, in plain words; `detail` stays the technical answer.
		let hint: string | null = s.status === 'ok' ? null : (s.hint ?? null);
		if (c.availability === 'live' && !checked) hint = 'Press Check now.';
		else if (old && s.status !== 'error')
			hint =
				'The hourly check may have stopped: press Check now, and tell a developer if it stays old.';
		if (c.availability === 'live') {
			if (s.status === 'error') level = 'error';
			else if (s.status === 'ok' && !old) level = 'ok';
			else level = 'warning';
		}
		return {
			id: c.id,
			name: c.name,
			availability: c.availability,
			level,
			status: c.availability === 'planned' ? 'planned' : (s.status ?? 'not_checked'),
			detail: old
				? `Not checked for hours: the hourly check may have stopped. ${s.detail ?? ''}`
				: (s.detail ?? ''),
			hint,
			lastCheckAt: ms(s.lastCheckAt),
			lastEventAt: ms(s.lastEventAt),
			lastSyncAt: ms(s.lastSyncAt)
		};
	});

	const automationRows = AUTOMATIONS.map((a) => {
		const s = autoState.get(a.id) ?? {};
		const on = typeof s.enabled === 'boolean' ? s.enabled : a.defaultEnabled;
		const ran = ms(s.lastRunAt);
		// A daily job that ran once and then stopped: the schedule may be broken.
		const late = on && a.trigger === 'schedule' && !!ran && Date.now() - ran > RUN_STALE;
		// Switched off is a warning: something the team expects may not be happening.
		let level: Level = 'warning';
		if (on && s.lastError) level = 'error';
		else if (on && !late) level = 'ok';
		return {
			id: a.id,
			name: a.name,
			enabled: on,
			level,
			lastRunAt: ms(s.lastRunAt),
			lastError: late ? `Hasn't run for over 2 days.` : (s.lastError ?? null),
			runs: s.runs ?? 0,
			errors: s.errors ?? 0
		};
	});

	const levels = [...connectionRows, ...automationRows].map((r) => r.level);
	let overall: Level = 'ok';
	if (levels.includes('error')) overall = 'error';
	else if (levels.includes('warning')) overall = 'warning';

	return {
		overall,
		connections: connectionRows,
		automations: automationRows
	};
}
