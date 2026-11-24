<script lang="ts">
	import { onMount } from 'svelte';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { callAction, errorText } from '$lib/actions';
	import { setTitle, relative, formatDateTime } from '$lib/utils';
	import type { Health, Level } from '$lib/types/connections';
	import StatusDot from '$lib/components/shared/StatusDot.svelte';
	import FormError from '$lib/components/shared/FormError.svelte';

	setTitle('Health', 'Is everything connected and running?');

	let health = $state<Health | null>(null);
	let error = $state<string | null>(null);
	let loading = $state(false);

	async function load() {
		loading = true;
		error = null;
		try {
			health = await callAction<Health>('connections:health.get');
		} catch (e) {
			error = errorText(e);
		} finally {
			loading = false;
		}
	}
	onMount(load);

	const OVERALL: Record<Level, [string, string]> = {
		ok: ['All systems working', 'bg-success/10 border-success/30'],
		warning: ['Working, with connections still to set up', 'bg-warning/10 border-warning/30'],
		error: ['Something is failing', 'bg-danger/10 border-danger/30'],
		off: ['Nothing switched on', 'bg-canvas border-line']
	};
	const STATUS: Record<string, string> = {
		ok: 'Working',
		error: 'Failing',
		not_configured: 'Needs setup',
		not_checked: 'Not checked yet',
		planned: 'Planned'
	};
</script>

<div class="mx-auto max-w-5xl space-y-4">
	<FormError message={error} />
	{#if health}
		{@const [text, tone] = OVERALL[health.overall]}
		<div class="flex items-center justify-between rounded-xl border px-5 py-4 {tone}">
			<div>
				<StatusDot level={health.overall} label={text} />
				<p class="mt-1 text-xs text-ink-soft">
					Connections are checked every hour. Last new contact: {health.data.lastContactAt
						? relative(health.data.lastContactAt)
						: 'none yet'}.
				</p>
			</div>
			<button class="btn-ghost" onclick={load} disabled={loading}>
				<RefreshCw class="h-4 w-4 {loading ? 'animate-spin' : ''}" /> Refresh
			</button>
		</div>

		<section class="card">
			<div class="border-b border-line/60 px-4 py-3 font-bold">Connections</div>
			<table class="w-full text-sm">
				<tbody class="divide-y divide-line/40">
					{#each health.connections as c (c.id)}
						<tr>
							<td class="w-48 px-4 py-2 font-medium">
								<a href="/connections" class="hover:text-primary-700">{c.name}</a>
							</td>
							<td class="w-36 px-4 py-2">
								<StatusDot level={c.level} label={STATUS[c.status] ?? c.status} />
							</td>
							<td class="px-4 py-2 text-xs text-ink-soft">{c.detail}</td>
							<td class="w-40 px-4 py-2 text-right text-xs text-ink-soft">
								{#if c.lastCheckAt}checked {relative(c.lastCheckAt)}{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>

		<section class="card">
			<div class="border-b border-line/60 px-4 py-3 font-bold">Automations</div>
			<table class="w-full text-sm">
				<tbody class="divide-y divide-line/40">
					{#each health.automations as a (a.id)}
						<tr>
							<td class="w-48 px-4 py-2 font-medium">
								<a href="/automations" class="hover:text-primary-700">{a.name}</a>
							</td>
							<td class="w-36 px-4 py-2">
								<StatusDot
									level={a.level}
									label={a.enabled ? (a.lastError ? 'Last run failed' : 'On') : 'Off'}
								/>
							</td>
							<td class="px-4 py-2 text-xs {a.lastError ? 'text-danger' : 'text-ink-soft'}">
								{a.lastError ??
									`${a.runs} ${a.runs === 1 ? 'run' : 'runs'} · ${a.errors} ${a.errors === 1 ? 'error' : 'errors'}`}
							</td>
							<td class="w-40 px-4 py-2 text-right text-xs text-ink-soft">
								{a.lastRunAt ? `ran ${formatDateTime(a.lastRunAt)}` : 'never ran'}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>
	{:else if loading}
		<p class="text-sm text-ink-soft">Checking…</p>
	{/if}
</div>
