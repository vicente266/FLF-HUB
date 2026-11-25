<script lang="ts">
	import { collection, query, where, orderBy, limit } from 'firebase/firestore';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import { db } from '$lib/firebase';
	import { callAction, errorText } from '$lib/actions';
	import { hasPermission, listen, formatDate, relative, toDate } from '$lib/utils';
	import { contactTitle, crmConfig, stageLabel } from '$lib/helpers/crmConfig.svelte';
	import type { CalendarEvent, Contact, Task } from '$lib/types/crm';
	import Modal from '$lib/components/shared/Modal.svelte';

	// One Fellow at a glance: stats, meetings, wellbeing (PERMA) and money, from the Hub and the portal
	// sheet. Wellbeing and money load through their own actions, only for people allowed to see them;
	// none of it is ever given to Claude.
	let { open = $bindable(false), contact }: { open: boolean; contact: Contact } = $props();

	const cfg = crmConfig();
	const canWellbeing = hasPermission('wellbeing.any.read');
	const canWealth = hasPermission('wealth.any.read');

	interface Perma {
		completedAt: number | null;
		scores: Record<string, number | null>;
	}
	interface Finance {
		startingIncome?: number | null;
		currentIncome?: number | null;
		growth?: string;
		reports?: Record<string, Record<string, { gross: number; net: number; value: number }>>;
	}

	let tab = $state<'overview' | 'meetings' | 'wellbeing' | 'money'>('overview');
	let meetings = $state<CalendarEvent[]>([]);
	let tasks = $state<Task[]>([]);
	// undefined = loading, null = none / failed.
	let perma = $state<Perma[] | null | undefined>(undefined);
	let money = $state<Finance | null | undefined>(undefined);
	let wellbeingError = $state<string | null>(null);
	let moneyError = $state<string | null>(null);
	let loadError = $state<string | null>(null);

	// Load only while open, and again for another contact.
	let id = $derived(contact.id);
	$effect(() => {
		if (!open) return;
		const cid = id;
		// Answers for a contact shown before are ignored once this one is open.
		let alive = true;
		tab = 'overview';
		perma = undefined;
		money = undefined;
		meetings = [];
		tasks = [];
		loadError = null;
		wellbeingError = null;
		moneyError = null;
		if (canWellbeing)
			callAction<Perma[]>('portal:wellbeing.get', { contactId: cid })
				.then((r) => alive && (perma = r))
				.catch((e) => {
					if (!alive) return;
					perma = null;
					wellbeingError = errorText(e);
				});
		if (canWealth)
			callAction<Finance | null>('portal:finance.get', { contactId: cid })
				.then((r) => alive && (money = r))
				.catch((e) => {
					if (!alive) return;
					money = null;
					moneyError = errorText(e);
				});
		const unsubs = [
			listen<CalendarEvent>(
				query(
					collection(db, 'event'),
					where('contactIds', 'array-contains', cid),
					orderBy('date', 'desc'),
					limit(100)
				),
				(rows) => (meetings = rows)
			),
			listen<Task>(
				query(collection(db, 'task'), where('contactId', '==', cid), orderBy('dueAt'), limit(50)),
				(rows) => (tasks = rows)
			)
		];
		return () => {
			alive = false;
			unsubs.forEach((u) => u());
		};
	});

	const DAY = 86_400_000;
	let pt = $derived(contact.portal);
	let lastMeeting = $derived(meetings.find((m) => (toDate(m.date)?.getTime() ?? 0) <= Date.now()));
	let meetings90 = $derived(
		meetings.filter((m) => {
			const t = toDate(m.date)?.getTime() ?? 0;
			return t <= Date.now() && t >= Date.now() - 90 * DAY;
		}).length
	);
	let openTasks = $derived(tasks.filter((t) => !t.done));
	let daysInStage = $derived.by(() => {
		const t = toDate(contact.stageChangedAt)?.getTime();
		return t ? Math.max(0, Math.floor((Date.now() - t) / DAY)) : null;
	});

	const PERMA_KEYS = ['P', 'E', 'R', 'M', 'A', 'N', 'H', 'Loneliness', 'Happiness', 'Overall'];
	const PERMA_LABEL: Record<string, string> = {
		P: 'Positive emotion',
		E: 'Engagement',
		R: 'Relationships',
		M: 'Meaning',
		A: 'Accomplishment',
		N: 'Negative emotion',
		H: 'Health',
		Loneliness: 'Loneliness',
		Happiness: 'Happiness',
		Overall: 'Overall'
	};
	// For N and Loneliness lower is better, so their change is shown the other way round.
	const LOWER_IS_BETTER = new Set(['N', 'Loneliness']);
	function change(k: string): { text: string; tone: string } | null {
		if (!perma || perma.length < 2) return null;
		const a = perma[0].scores[k];
		const b = perma[1].scores[k];
		if (typeof a !== 'number' || typeof b !== 'number' || a === b) return null;
		const better = LOWER_IS_BETTER.has(k) ? a < b : a > b;
		return {
			text: `${a > b ? '+' : ''}${Math.round((a - b) * 10) / 10}`,
			tone: better ? 'text-success' : 'text-danger'
		};
	}
	const eur = (n: number | null | undefined) =>
		typeof n === 'number' ? `€${Math.round(n).toLocaleString('en-GB')}` : '—';
	const nextStepLabel = (sid?: string) =>
		cfg.value?.nextSteps.find((s) => s.id === sid)?.label ?? '';
</script>

<Modal bind:open title={`${contactTitle(contact)} · Fellow profile`} width="max-w-3xl">
	<div class="-mt-1 mb-4 flex w-fit flex-wrap rounded-lg border border-line/70 bg-white p-0.5">
		{#each [['overview', 'Overview'], ['meetings', `Meetings (${meetings.length})`], ...(canWellbeing ? [['wellbeing', 'Wellbeing']] : []), ...(canWealth ? [['money', 'Finance']] : [])] as [value, label] (value)}
			<button
				class="rounded-md px-3 py-1 text-sm font-semibold {tab === value
					? 'bg-primary-600 text-white'
					: 'text-ink-soft'}"
				onclick={() => (tab = value as typeof tab)}
			>
				{label}
			</button>
		{/each}
	</div>

	{#if loadError}<p class="mb-3 text-sm text-danger">{loadError}</p>{/if}

	{#if tab === 'overview'}
		<div class="grid grid-cols-2 gap-3 md:grid-cols-4">
			{#each [['Stage', cfg.value ? stageLabel(cfg.value, contact.type, contact.stage) : contact.stage], ['Days in stage', daysInStage ?? '—'], ['Meetings (90 days)', meetings90], ['Open tasks', openTasks.length]] as [label, value] (label)}
				<div class="rounded-lg bg-canvas px-3 py-2">
					<div class="text-[11px] font-semibold text-ink-soft">{label}</div>
					<div class="text-lg font-bold">{value}</div>
				</div>
			{/each}
		</div>

		<dl class="mt-4 grid grid-cols-1 gap-x-8 gap-y-2 text-sm md:grid-cols-2">
			{#each [['Cohort', pt?.cohort], ['Sherpa', contact.ownerName || pt?.sherpaName], ['Archetype', pt?.archetype], ['Location', pt?.location], ['Company', contact.company], ['Funnel stage', pt?.funnelStage], ['Next step', nextStepLabel(contact.nextStep)], ['Last meeting', lastMeeting ? `${formatDate(lastMeeting.date)} · ${lastMeeting.name ?? lastMeeting.title}` : ''], ['Last activity', relative(contact.lastActivityAt)], ['Last interaction (portal)', pt?.lastInteraction ? formatDate(pt.lastInteraction) : ''], ['Portal access', pt?.onPortal == null ? '' : pt.onPortal ? 'Yes' : 'No']] as [label, value] (label)}
				<div class="flex justify-between gap-3 border-b border-line/40 py-1">
					<dt class="text-ink-soft">{label}</dt>
					<dd class="truncate text-right font-medium">{value || '—'}</dd>
				</div>
			{/each}
		</dl>

		<section class="mt-4 rounded-lg border border-line/60 px-4 py-3">
			<div class="eyebrow">Founder’s Pledge</div>
			<div class="mt-1 flex items-center justify-between text-sm">
				<span>
					{#if pt?.pledgeSigned === true}Signed{pt.pledgeDate
							? ` on ${formatDate(pt.pledgeDate)}`
							: ''}{:else if pt?.pledgeSigned === false}Not signed yet{:else}No pledge data from the
						Portal{/if}
				</span>
				{#if pt?.contractUrl}
					<a
						href={pt.contractUrl}
						target="_blank"
						rel="noopener noreferrer"
						class="flex items-center gap-1 text-primary-700"
					>
						Open contract <ExternalLink class="h-3.5 w-3.5" />
					</a>
				{/if}
			</div>
		</section>

		{#if pt?.reasonsWhy}
			<section class="mt-3 text-sm">
				<div class="eyebrow">Reasons why</div>
				<p class="mt-1 whitespace-pre-line text-ink-soft">{pt.reasonsWhy}</p>
			</section>
		{/if}

		{#if openTasks.length}
			<section class="mt-3 text-sm">
				<div class="eyebrow">Open tasks</div>
				<ul class="mt-1 space-y-1">
					{#each openTasks.slice(0, 5) as t (t.id)}
						<li class="flex justify-between gap-3">
							<span class="truncate">{t.title}</span>
							<span class="shrink-0 text-xs text-ink-soft">{formatDate(t.dueAt)}</span>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{:else if tab === 'meetings'}
		{#if meetings.length}
			<ul class="divide-y divide-line/40 text-sm">
				{#each meetings as m (m.id)}
					<li class="flex gap-4 py-2">
						<span class="w-24 shrink-0 text-xs font-semibold text-ink-soft">
							{formatDate(m.date)}
						</span>
						<span class="min-w-0 flex-1">
							{m.name ?? m.title}
							{#if m.type && !m.name}<span class="text-xs text-ink-soft"> · {m.type}</span>{/if}
							<span class="block text-xs text-ink-soft">
								{m.participants.map((p) => p.name).join(', ')}
							</span>
						</span>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="text-sm text-ink-soft">No meetings yet. They are synced from the Portal.</p>
		{/if}
	{:else if tab === 'wellbeing'}
		{#if perma === undefined}
			<p class="text-sm text-ink-soft">Loading…</p>
		{:else if wellbeingError}
			<p class="text-sm text-danger">Couldn't load the check-ins: {wellbeingError}</p>
		{:else if !perma?.length}
			<p class="text-sm text-ink-soft">No PERMA check-ins yet.</p>
		{:else}
			<p class="mb-3 text-xs text-ink-soft">
				Latest of {perma.length} check-ins, {formatDate(perma[0].completedAt)}{perma.length > 1
					? `; change since ${formatDate(perma[1].completedAt)}`
					: ''}. Scores 0–10; for negative emotion and loneliness, lower is better.
			</p>
			<div class="grid grid-cols-2 gap-2 md:grid-cols-5">
				{#each PERMA_KEYS as k (k)}
					{@const d = change(k)}
					<div class="rounded-lg bg-canvas px-3 py-2">
						<div class="truncate text-[11px] font-semibold text-ink-soft">{PERMA_LABEL[k]}</div>
						<div class="flex items-baseline gap-1.5">
							<span class="text-lg font-bold">{perma[0].scores[k] ?? '—'}</span>
							{#if d}<span class="text-xs font-semibold {d.tone}">{d.text}</span>{/if}
						</div>
					</div>
				{/each}
			</div>
			<div class="mt-4 overflow-x-auto">
				<table class="w-full text-xs">
					<thead class="text-left text-ink-soft">
						<tr>
							<th class="py-1 font-semibold">Date</th>
							{#each PERMA_KEYS as k (k)}<th class="py-1 text-right font-semibold">
									{k.slice(0, 5)}
								</th>{/each}
						</tr>
					</thead>
					<tbody class="divide-y divide-line/40">
						{#each perma as row, i (i)}
							<tr>
								<td class="py-1">{formatDate(row.completedAt)}</td>
								{#each PERMA_KEYS as k (k)}<td class="py-1 text-right">
										{row.scores[k] ?? '—'}
									</td>{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	{:else if tab === 'money'}
		{#if money === undefined}
			<p class="text-sm text-ink-soft">Loading…</p>
		{:else if moneyError}
			<p class="text-sm text-danger">Couldn't load the financial data: {moneyError}</p>
		{:else if money === null}
			<p class="text-sm text-ink-soft">No financial data from the Portal.</p>
		{:else}
			<div class="grid grid-cols-1 gap-3 md:grid-cols-3">
				{#each [['Starting income', eur(money.startingIncome)], ['Current income', eur(money.currentIncome)], ['Growth', money.growth || '—']] as [label, value] (label)}
					<div class="rounded-lg bg-canvas px-3 py-2">
						<div class="text-[11px] font-semibold text-ink-soft">{label}</div>
						<div class="text-lg font-bold">{value}</div>
					</div>
				{/each}
			</div>
			{#each Object.entries(money.reports ?? {}) as [report, rows] (report)}
				<section class="mt-3 text-sm">
					<div class="font-semibold">{report}</div>
					<dl class="mt-1 space-y-0.5">
						{#each Object.entries(rows) as [kind, t] (kind)}
							<div class="flex justify-between text-ink-soft">
								<dt>{kind}</dt>
								<dd>
									{t.value ? `${eur(t.value)} value` : ''}{t.value && (t.net || t.gross)
										? ' · '
										: ''}{t.net || t.gross
										? `${eur(t.net || t.gross)} ${t.net ? 'net' : 'gross'}`
										: ''}
								</dd>
							</div>
						{/each}
					</dl>
				</section>
			{:else}
				<p class="mt-3 text-sm text-ink-soft">No wealth report filed yet.</p>
			{/each}
		{/if}
	{/if}
</Modal>
