<script lang="ts">
	import { onMount } from 'svelte';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { callAction, errorText } from '$lib/actions';
	import { setTitle, formatDateTime } from '$lib/utils';
	import { crmConfig } from '$lib/helpers/crmConfig.svelte';
	import type { ContactType } from '$lib/types/crm';
	import FormError from '$lib/components/shared/FormError.svelte';
	import Empty from '$lib/components/shared/Empty.svelte';

	setTitle('Reports', 'Pipeline from the CRM · data from Google Sheets and BigQuery');

	interface Summary {
		funnel: Record<ContactType, { stage: string; label: string; count: number }[]>;
		sources: { source: string; count: number }[];
		kpis: { newLast30: number; needsAttention: number; openTasks: number; overdueTasks: number };
	}
	interface Sheet {
		id: string;
		name: string;
		header: string[];
		rows: Record<string, string>[];
		syncedAt: number | null;
	}

	const cfg = crmConfig();
	let summary = $state<Summary | null>(null);
	let sheets = $state<Sheet[]>([]);
	let error = $state<string | null>(null);
	let loading = $state(false);
	let tab = $state<string>('pipeline');

	async function load() {
		loading = true;
		error = null;
		try {
			[summary, sheets] = await Promise.all([
				callAction<Summary>('reports:summary'),
				callAction<Sheet[]>('reports:sheets.list')
			]);
		} catch (e) {
			error = errorText(e);
		} finally {
			loading = false;
		}
	}
	onMount(load);

	const max = (rows: { count: number }[]) => Math.max(1, ...rows.map((r) => r.count));
</script>

<div class="mx-auto max-w-6xl space-y-4">
	<div class="flex items-center justify-between">
		<div class="flex rounded-lg border border-line/70 bg-white p-0.5">
			<button
				class="rounded-md px-3 py-1 text-sm font-semibold {tab === 'pipeline'
					? 'bg-primary-600 text-white'
					: 'text-ink-soft'}"
				onclick={() => (tab = 'pipeline')}
			>
				Pipeline
			</button>
			{#each sheets as s (s.id)}
				<button
					class="rounded-md px-3 py-1 text-sm font-semibold {tab === s.id
						? 'bg-primary-600 text-white'
						: 'text-ink-soft'}"
					onclick={() => (tab = s.id)}
				>
					{s.name}
				</button>
			{/each}
		</div>
		<button class="btn-ghost" onclick={load} disabled={loading}>
			<RefreshCw class="h-4 w-4 {loading ? 'animate-spin' : ''}" /> Refresh
		</button>
	</div>
	<FormError message={error} />

	{#if tab === 'pipeline' && summary && cfg.value}
		{@const s = summary}
		<div class="grid grid-cols-4 gap-3">
			{#each [['New contacts (30 days)', s.kpis.newLast30], ['Need attention', s.kpis.needsAttention], ['Open tasks', s.kpis.openTasks], ['Overdue tasks', s.kpis.overdueTasks]] as [label, value] (label)}
				<div class="card px-4 py-3">
					<div class="text-xs font-semibold text-ink-soft">{label}</div>
					<div class="mt-1 text-2xl font-bold">{value}</div>
				</div>
			{/each}
		</div>

		<div class="grid grid-cols-3 gap-4">
			{#each cfg.value.types as t (t)}
				{@const rows = s.funnel[t]}
				<section class="card px-4 py-3">
					<div class="eyebrow">{cfg.value.pipelines[t].plural}</div>
					<div class="mt-1 text-xs text-ink-soft">
						{rows.reduce((a, r) => a + r.count, 0)} in total
					</div>
					<ul class="mt-3 space-y-2">
						{#each rows as r (r.stage)}
							<li>
								<div class="flex justify-between text-xs">
									<span>{r.label}</span><span class="font-semibold">{r.count}</span>
								</div>
								<div class="mt-0.5 h-2 rounded-full bg-primary-50">
									<div
										class="h-2 rounded-full bg-primary-600"
										style="width: {(r.count / max(rows)) * 100}%"
									></div>
								</div>
							</li>
						{/each}
					</ul>
				</section>
			{/each}
		</div>

		<section class="card px-4 py-3">
			<div class="eyebrow">Where contacts came from · last 30 days</div>
			<div class="mt-3 grid grid-cols-5 gap-3">
				{#each s.sources as src (src.source)}
					<div>
						<div class="text-xs text-ink-soft capitalize">{src.source}</div>
						<div class="text-xl font-bold">{src.count}</div>
					</div>
				{/each}
			</div>
		</section>

		{#if sheets.length === 0}
			<Empty title="No Google Sheets connected yet">
				Add sheets in <a class="text-primary-700" href="/connections">
					Connections → Google Sheets
				</a> and they appear here as tabs.
			</Empty>
		{/if}
	{:else}
		{@const sheet = sheets.find((x) => x.id === tab)}
		{#if sheet}
			<p class="text-xs text-ink-soft">
				Synced {formatDateTime(sheet.syncedAt)} · {sheet.rows.length} rows
			</p>
			<div class="overflow-x-auto card">
				<table class="w-full text-sm">
					<thead class="bg-canvas text-left text-xs text-ink-soft">
						<tr>
							{#each sheet.header as h, i (i)}<th class="px-3 py-2 font-semibold whitespace-nowrap">
									{h}
								</th>{/each}
						</tr>
					</thead>
					<tbody class="divide-y divide-line/40">
						{#each sheet.rows as row, r (r)}
							<tr>
								{#each sheet.header.keys() as i (i)}<td class="px-3 py-1.5 whitespace-nowrap">
										{row[String(i)] ?? ''}
									</td>{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	{/if}
</div>
