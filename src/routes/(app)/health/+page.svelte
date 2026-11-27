<script lang="ts">
	import { onMount } from 'svelte';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { callAction, errorText } from '$lib/actions';
	import { setTitle, relative, formatDateTime, hasPermission } from '$lib/utils';
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

	const canResolve = hasPermission('automations.any.write');
	// Names link to pages only for people who can open them.
	const canConnections = hasPermission('connections.any.read');
	const canAutomations = hasPermission('automations.any.read');
	function automationLabel(a: Health['automations'][number]) {
		if (!a.enabled) return 'Off';
		if (a.lastError) return 'Last run failed';
		if (a.late) return 'Not running';
		return 'On';
	}
	async function resolve(id: string) {
		error = null;
		try {
			await callAction('automations:resolve', { id });
			await load();
		} catch (e) {
			error = errorText(e);
		}
	}

	/** Check every connection now, then show the fresh results (Refresh alone only re-reads them). */
	const canCheck = hasPermission('connections.any.read');
	async function checkNow() {
		if (!canCheck) return load();
		loading = true;
		error = null;
		const ids = health?.connections.filter((c) => c.availability === 'live').map((c) => c.id) ?? [];
		const results = await Promise.allSettled(
			ids.map((id) => callAction('connections:test', { id }, { timeout: 120_000 }))
		);
		await load();
		// A test that couldn't run (no permission, timeout) is reported, not hidden.
		const failed = results.flatMap((r, i) =>
			r.status === 'rejected'
				? [
						`${health?.connections.find((c) => c.id === ids[i])?.name ?? ids[i]}: ${errorText(r.reason)}`
					]
				: []
		);
		if (failed.length) error = `Couldn’t check ${failed.join(' · ')}`;
	}

	const OVERALL: Record<Level, [string, string]> = {
		ok: ['All systems working', 'bg-success/10 border-success/30'],
		warning: ['Working, but some things need attention', 'bg-warning/10 border-warning/30'],
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
		{@const unchecked = health.connections.every(
			(c) => c.availability !== 'live' || !c.lastCheckAt
		)}
		{@const [text, tone] = unchecked
			? [
					canCheck ? 'Not checked yet — press Check now' : 'Not checked yet',
					'bg-canvas border-line'
				]
			: OVERALL[health.overall]}
		<div class="flex items-center justify-between rounded-xl border px-5 py-4 {tone}">
			<div>
				<StatusDot level={unchecked ? 'off' : health.overall} label={text} />
				<p class="mt-1 text-xs text-ink-soft">
					Connections are checked every hour, or now with Check now. A failure already dealt with
					can be marked resolved.
				</p>
			</div>
			<button class="btn-ghost" onclick={checkNow} disabled={loading}>
				<RefreshCw class="h-4 w-4 {loading ? 'animate-spin' : ''}" />
				{canCheck ? 'Check now' : 'Refresh'}
			</button>
		</div>

		<section class="card">
			<div class="border-b border-line/60 px-4 py-3 font-bold">Connections</div>
			<table class="w-full text-sm">
				<tbody class="divide-y divide-line/40">
					{#each health.connections as c (c.id)}
						<tr>
							<td class="w-48 px-4 py-2 align-top font-medium">
								{#if canConnections}
									<a href="/connections?open={c.id}" class="hover:text-primary-700">{c.name}</a>
								{:else}{c.name}{/if}
							</td>
							<td class="w-36 px-4 py-2 align-top">
								<StatusDot level={c.level} label={STATUS[c.status] ?? c.status} />
							</td>
							<td class="px-4 py-2 text-xs text-ink-soft">
								{#if c.level !== 'ok' && c.hint}
									<p class="text-sm text-ink">
										<span class="font-semibold">What to do:</span>
										{c.hint}
										{#if canConnections}
											<a
												href="/connections?open={c.id}"
												class="font-semibold whitespace-nowrap text-primary-700 hover:underline"
											>
												Open {c.name}
											</a>
										{/if}
									</p>
									{#if c.detail}
										<details class="mt-0.5">
											<summary class="w-fit">Details</summary>
											<p class="mt-0.5 break-words">{c.detail}</p>
										</details>
									{/if}
								{:else}
									{c.detail}
								{/if}
							</td>
							<td class="w-40 px-4 py-2 text-right align-top text-xs text-ink-soft">
								{#if c.lastCheckAt}checked {relative(c.lastCheckAt)}{:else}never checked{/if}
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
								{#if canAutomations}
									<a href="/automations" class="hover:text-primary-700">{a.name}</a>
								{:else}{a.name}{/if}
							</td>
							<td class="w-36 px-4 py-2">
								<StatusDot level={a.level} label={automationLabel(a)} />
							</td>
							<td class="px-4 py-2 text-xs {a.lastError ? 'text-danger' : 'text-ink-soft'}">
								{#if a.lastError}{a.lastError}
								{:else if a.late}<span class="text-warning">
										Hasn't run for over 2 days: the schedule may have stopped. Tell a developer.
									</span>
								{:else}{a.runs}
									{a.runs === 1 ? 'run' : 'runs'} · {a.errors}
									{a.errors === 1 ? 'error' : 'errors'}{/if}
								{#if a.lastError && canResolve}
									<button
										class="ml-2 font-semibold text-primary-700 hover:underline"
										onclick={() => resolve(a.id)}
									>
										Mark resolved
									</button>
								{/if}
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
