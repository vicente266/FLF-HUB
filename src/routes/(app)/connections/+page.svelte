<script lang="ts">
	import { onMount } from 'svelte';
	import { collection } from 'firebase/firestore';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import PlugZap from '@lucide/svelte/icons/plug-zap';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { db } from '$lib/firebase';
	import { callAction, errorText } from '$lib/actions';
	import { hasPermission, listen, setTitle, formatDateTime } from '$lib/utils';
	import type { Category, ConnectionState, Connector, Level, Status } from '$lib/types/connections';
	import StatusDot from '$lib/components/shared/StatusDot.svelte';
	import FormError from '$lib/components/shared/FormError.svelte';

	setTitle('Connections', 'Everything the Hub is wired to, and how to wire the rest');

	const canWrite = hasPermission('connections.any.write');
	let connectors = $state<Connector[]>([]);
	let categories = $state<Record<Category, string> | null>(null);
	let states = $state<Record<string, ConnectionState>>({});
	let open = $state<string | null>(null);
	let busy = $state<string | null>(null);
	let error = $state<string | null>(null);
	let drafts = $state<Record<string, Record<string, string>>>({});

	onMount(() => {
		callAction<{ connectors: Connector[]; categories: Record<Category, string> }>(
			'connections:config.get'
		).then((r) => {
			connectors = r.connectors;
			categories = r.categories;
		});
		return listen<ConnectionState>(collection(db, 'connection'), (rows) => {
			states = Object.fromEntries(rows.map((r) => [r.id, r]));
		});
	});

	function statusOf(c: Connector): Status {
		if (c.availability === 'planned') return 'planned';
		return states[c.id]?.status ?? 'not_checked';
	}

	const LEVEL: Record<Status, Level> = {
		ok: 'ok',
		error: 'error',
		not_configured: 'warning',
		not_checked: 'warning',
		planned: 'off'
	};
	const LABEL: Record<Status, string> = {
		ok: 'Working',
		error: 'Failing',
		not_configured: 'Needs setup',
		not_checked: 'Not checked',
		planned: 'Planned'
	};

	function toggle(c: Connector) {
		open = open === c.id ? null : c.id;
		drafts[c.id] ??= { ...(states[c.id]?.settings ?? {}) };
	}

	async function run(label: string, fn: () => Promise<unknown>) {
		busy = label;
		error = null;
		try {
			await fn();
		} catch (e) {
			error = errorText(e);
		} finally {
			busy = null;
		}
	}

	const test = (c: Connector) =>
		run(`test:${c.id}`, () => callAction('connections:test', { id: c.id }, { timeout: 120_000 }));
	const save = (c: Connector) =>
		run(`save:${c.id}`, async () => {
			await callAction('connections:settings.save', { id: c.id, settings: drafts[c.id] });
			if (c.testable) await callAction('connections:test', { id: c.id }, { timeout: 120_000 });
		});
	/** The last portal dry run or import, shown under its card. */
	let portalResult = $state<Record<string, unknown> | null>(null);
	const portal = (action: 'sync.plan' | 'sync.run') =>
		run(`portal:${action}`, async () => {
			portalResult = await callAction<Record<string, unknown>>(
				`portal:${action}`,
				{},
				{ timeout: 300_000 }
			);
		});
	const syncSheets = () =>
		run('sync', () => callAction('connections:sheets.sync', {}, { timeout: 300_000 }));

	let grouped = $derived(
		categories
			? (Object.keys(categories) as Category[])
					.map((cat) => ({
						cat,
						label: categories![cat],
						items: connectors.filter((c) => c.category === cat)
					}))
					.filter((g) => g.items.length)
			: []
	);
	let live = $derived(connectors.filter((c) => c.availability === 'live'));
	let working = $derived(live.filter((c) => statusOf(c) === 'ok').length);
</script>

<div class="mx-auto max-w-5xl space-y-5">
	<div class="flex items-center justify-between card px-5 py-4">
		<div>
			<div class="eyebrow">Connection map</div>
			<p class="mt-1 text-sm text-ink-soft">
				{working} of {live.length} live connections working · {connectors.length - live.length} planned.
				Secrets (tokens, keys) are never stored here: they go in Secret Manager.
			</p>
		</div>
		<a href="/health" class="btn-ghost">Open Health</a>
	</div>
	<FormError message={error} />

	{#each grouped as g (g.cat)}
		<section>
			<h2 class="mb-2 eyebrow">{g.label}</h2>
			<div class="space-y-2">
				{#each g.items as c (c.id)}
					{@const s = states[c.id]}
					{@const status = statusOf(c)}
					<div class="card">
						<button
							class="flex w-full items-center gap-4 px-4 py-3 text-left"
							onclick={() => toggle(c)}
						>
							<PlugZap
								class="h-5 w-5 shrink-0 {c.availability === 'live'
									? 'text-primary-600'
									: 'text-line'}"
							/>
							<div class="min-w-0 flex-1">
								<div class="font-semibold">{c.name}</div>
								<div class="truncate text-xs text-ink-soft">{c.description}</div>
							</div>
							<div class="w-40 shrink-0 truncate text-xs text-ink-soft">
								Feeds {c.feeds.join(', ')}
							</div>
							<div class="w-28 shrink-0">
								<StatusDot level={LEVEL[status]} label={LABEL[status]} />
							</div>
						</button>

						{#if open === c.id}
							<div class="grid grid-cols-2 gap-6 border-t border-line/60 px-4 py-4 text-sm">
								<div class="space-y-3">
									<div>
										<div class="label">Setup</div>
										<ol class="list-decimal space-y-1 pl-4 text-ink-soft">
											{#each c.setup as step, i (i)}<li>{step}</li>{/each}
										</ol>
									</div>
									{#if c.secrets.length}
										<div>
											<div class="label">Secrets (Secret Manager)</div>
											<div class="flex flex-wrap gap-1">
												{#each c.secrets as name (name)}
													<code
														class="inline-flex items-center gap-1 rounded bg-canvas px-1.5 py-0.5 text-xs"
													>
														<KeyRound class="h-3 w-3" />{name}
													</code>
												{/each}
											</div>
										</div>
									{/if}
								</div>

								<div class="space-y-3">
									{#if c.settings.length}
										{#each c.settings as f (f.key)}
											<div>
												<label class="label" for="{c.id}-{f.key}">{f.label}</label>
												{#if f.kind === 'list'}
													<textarea
														id="{c.id}-{f.key}"
														class="input font-mono text-xs"
														rows="4"
														disabled={!canWrite || c.availability === 'planned'}
														bind:value={drafts[c.id][f.key]}></textarea>
												{:else}
													<input
														id="{c.id}-{f.key}"
														class="input"
														disabled={!canWrite || c.availability === 'planned'}
														bind:value={drafts[c.id][f.key]}
													/>
												{/if}
												<p class="mt-0.5 text-xs text-ink-soft">{f.help}</p>
											</div>
										{/each}
									{/if}

									{#if c.availability === 'live'}
										<dl class="space-y-1 text-xs text-ink-soft">
											<div class="flex justify-between">
												<dt>Last check</dt>
												<dd>{formatDateTime(s?.lastCheckAt)}</dd>
											</div>
											{#if s?.lastEventAt}<div class="flex justify-between">
													<dt>Last event</dt>
													<dd>{formatDateTime(s.lastEventAt)}</dd>
												</div>{/if}
											{#if s?.lastSyncAt}<div class="flex justify-between">
													<dt>Last sync</dt>
													<dd>{formatDateTime(s.lastSyncAt)}</dd>
												</div>{/if}
											{#if s?.detail}<div class="pt-1 {status === 'error' ? 'text-danger' : ''}">
													{s.detail}
												</div>{/if}
										</dl>
										<div class="flex flex-wrap gap-2">
											{#if c.settings.length && canWrite}
												<button
													class="btn-primary"
													disabled={busy !== null}
													onclick={() => save(c)}
												>
													Save
												</button>
											{/if}
											{#if c.testable}
												<button class="btn-ghost" disabled={busy !== null} onclick={() => test(c)}>
													<RefreshCw
														class="h-4 w-4 {busy === `test:${c.id}` ? 'animate-spin' : ''}"
													/> Test
												</button>
											{/if}
											{#if c.id === 'portal-sheet' && canWrite}
												<button
													class="btn-ghost"
													disabled={busy !== null}
													onclick={() => portal('sync.plan')}
												>
													Dry run
												</button>
												<button
													class="btn-ghost"
													disabled={busy !== null}
													onclick={() => portal('sync.run')}
												>
													Sync now
												</button>
											{/if}
											{#if c.id === 'google-sheets' && canWrite}
												<button class="btn-ghost" disabled={busy !== null} onclick={syncSheets}>
													Sync now
												</button>
											{/if}
										</div>
										{#if c.id === 'portal-sheet' && portalResult}
											<pre
												class="max-h-60 overflow-auto rounded-lg bg-canvas px-3 py-2 text-[11px]">{JSON.stringify(
													portalResult,
													null,
													1
												)}</pre>
										{/if}
									{:else}
										<p class="rounded-lg bg-canvas px-3 py-2 text-xs text-ink-soft">
											Planned. It will feed {c.feeds.join(', ')} once built.
										</p>
									{/if}
								</div>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		</section>
	{/each}
</div>
