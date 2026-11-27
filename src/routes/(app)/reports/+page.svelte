<script lang="ts">
	import { onMount } from 'svelte';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { callAction, errorText } from '$lib/actions';
	import { setTitle } from '$lib/utils';
	import { crmConfig, sourceLabel } from '$lib/helpers/crmConfig.svelte';
	import type { ContactType, Stage } from '$lib/types/crm';
	import FormError from '$lib/components/shared/FormError.svelte';

	setTitle('Reports', 'Pipeline from the CRM');

	type Row = { stage: string; label: string; count: number };
	interface Summary {
		funnel: Record<ContactType, Row[]>;
		sources: { source: string; count: number }[];
	}

	const cfg = crmConfig();
	let summary = $state<Summary | null>(null);
	let error = $state<string | null>(null);
	let loading = $state(false);

	async function load() {
		loading = true;
		error = null;
		try {
			summary = await callAction<Summary>('reports:summary');
		} catch (e) {
			error = errorText(e);
		} finally {
			loading = false;
		}
	}
	onMount(load);

	const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);

	/**
	 * One pipeline as a funnel. Counts are where contacts are now, so "reached" a stage means being in
	 * it or any later working stage; a losing stage (Lost, Declined) is apart, out of the funnel.
	 * The funnel starts at the first stage with contacts (an unused first stage would read as 100%
	 * going on). `next` is the share of those who reached this stage that went on to the next one; the
	 * page shows '—' instead from a stage nobody is in, since nothing went through it to measure.
	 */
	function funnel(rows: Row[], stages: Stage[]) {
		const lost = new Set(stages.filter((s) => s.askReason).map((s) => s.id));
		const total = rows.reduce((a, r) => a + r.count, 0);
		const working = rows.filter((r) => !lost.has(r.stage));
		const first = working.findIndex((r) => r.count > 0);
		const path = first < 0 ? [] : working.slice(first);
		const reached = path.map((_, i) => path.slice(i).reduce((a, r) => a + r.count, 0));
		const next = (i: number) =>
			i < path.length - 1 ? `${pct(reached[i + 1], reached[i])}%` : null;
		return {
			total,
			skipped: first > 0 ? working.slice(0, first).map((r) => r.label) : [],
			path: path.map((r, i) => ({ ...r, share: pct(r.count, total), next: next(i) })),
			lost: rows.filter((r) => lost.has(r.stage)).map((r) => ({ ...r, share: pct(r.count, total) }))
		};
	}
</script>

<div class="mx-auto max-w-6xl space-y-4">
	<div class="flex items-center justify-between gap-3">
		<p class="text-sm text-ink-soft">
			Where contacts are now, per pipeline. Bars are a share of the pipeline's total; between
			stages, the share of those who reached a stage that went on to the next.
		</p>
		<button class="btn-ghost shrink-0" onclick={load} disabled={loading}>
			<RefreshCw class="h-4 w-4 {loading ? 'animate-spin' : ''}" /> Refresh
		</button>
	</div>
	<FormError message={error ?? cfg.error} />

	{#if summary && cfg.value}
		{@const s = summary}
		<div class="grid grid-cols-4 gap-4">
			{#each cfg.value.types as t (t)}
				{@const f = funnel(s.funnel[t] ?? [], cfg.value.pipelines[t].stages)}
				<section class="card px-4 py-3">
					<div class="flex items-baseline justify-between">
						<div class="eyebrow">{cfg.value.pipelines[t].plural}</div>
						<div class="text-xs text-ink-soft">{f.total} in total</div>
					</div>
					{#if f.skipped.length}
						<p class="mt-1 text-[11px] text-ink-soft" title="Stages with no contacts now">
							Starts after {f.skipped.join(', ')} (empty)
						</p>
					{/if}
					{#if !f.path.length}
						<p class="mt-3 text-xs text-ink-soft">No contacts in the pipeline yet.</p>
					{/if}
					<ul class="mt-3">
						{#each f.path as r (r.stage)}
							<li>
								<div class="flex justify-between gap-2 text-xs">
									<span>{r.label}</span>
									<span class="shrink-0">
										<span class="font-semibold">{r.count}</span>
										<span class="text-ink-soft">· {r.share}%</span>
									</span>
								</div>
								<div class="mt-0.5 h-2 rounded-full bg-primary-50">
									<div class="h-2 rounded-full bg-primary-600" style="width: {r.share}%"></div>
								</div>
								{#if r.next !== null}
									<div
										class="py-1 pl-2 text-[11px] text-ink-soft"
										title={r.count ? undefined : 'Nobody is in this stage now: nothing to measure'}
									>
										↓ {r.count ? `${r.next} went on` : '—'}
									</div>
								{/if}
							</li>
						{/each}
					</ul>
					{#each f.lost as r (r.stage)}
						<div class="mt-3 border-t border-line/50 pt-2">
							<div class="flex justify-between gap-2 text-xs">
								<span>{r.label}</span>
								<span class="shrink-0">
									<span class="font-semibold">{r.count}</span>
									<span class="text-ink-soft">· {r.share}%</span>
								</span>
							</div>
							<div class="mt-0.5 h-2 rounded-full bg-canvas">
								<div class="h-2 rounded-full bg-ink-soft/50" style="width: {r.share}%"></div>
							</div>
						</div>
					{/each}
				</section>
			{/each}
		</div>

		<section class="card px-4 py-3">
			<div class="eyebrow">Where contacts came from · last 30 days</div>
			<div class="mt-3 grid grid-cols-5 gap-3">
				{#each s.sources as src (src.source)}
					<div>
						<div class="text-xs text-ink-soft">{sourceLabel(src.source)}</div>
						<div class="text-xl font-bold">{src.count}</div>
					</div>
				{/each}
			</div>
		</section>
	{/if}
</div>
