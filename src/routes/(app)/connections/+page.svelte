<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { collection } from 'firebase/firestore';
	import { page } from '$app/state';
	import KeyRound from '@lucide/svelte/icons/key-round';
	import PlugZap from '@lucide/svelte/icons/plug-zap';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import { db } from '$lib/firebase';
	import { callAction, errorText } from '$lib/actions';
	import { hasPermission, listen, setTitle, formatDateTime } from '$lib/utils';
	import type { Category, ConnectionState, Connector, Level, Status } from '$lib/types/connections';
	import StatusDot from '$lib/components/shared/StatusDot.svelte';
	import FormError from '$lib/components/shared/FormError.svelte';
	import Modal from '$lib/components/shared/Modal.svelte';

	setTitle('Connections', 'Everything the Hub is wired to, and how to wire the rest');

	const canWrite = hasPermission('connections.any.write');
	let connectors = $state<Connector[]>([]);
	let categories = $state<Record<Category, string> | null>(null);
	let states = $state<Record<string, ConnectionState>>({});
	let open = $state<string | null>(null);
	let busy = $state<string | null>(null);
	let error = $state<string | null>(null);
	let drafts = $state<Record<string, Record<string, string>>>({});
	/** The saved settings arrive with the first snapshot: a form filled before it would be empty. */
	let statesLoaded = $state(false);

	onMount(() => {
		callAction<{ connectors: Connector[]; categories: Record<Category, string> }>(
			'connections:config.get'
		)
			.then(async (r) => {
				connectors = r.connectors;
				categories = r.categories;
				// /connections?open=<id> (from Health, Automations) opens that row.
				const id = page.url.searchParams.get('open');
				const c = connectors.find((x) => x.id === id);
				if (c) {
					toggle(c);
					await tick();
					document.getElementById(`conn-${c.id}`)?.scrollIntoView({ block: 'start' });
				}
			})
			.catch((e) => (error = errorText(e)));
		// Stage names for the import preview (portal contacts are Fellows).
		if (hasPermission('crm.any.read'))
			callAction<{ pipelines: Record<string, { stages: { id: string; label: string }[] }> }>(
				'crm:config.get'
			)
				.then(
					(r) =>
						(stageLabels = Object.fromEntries(
							r.pipelines.fellow.stages.map((s) => [s.id, s.label])
						))
				)
				.catch(() => {});
		return listen<ConnectionState>(collection(db, 'connection'), (rows) => {
			states = Object.fromEntries(rows.map((r) => [r.id, r]));
			statesLoaded = true;
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
		not_checked: 'Not checked yet',
		planned: 'Planned'
	};

	function toggle(c: Connector) {
		open = open === c.id ? null : c.id;
	}
	// The open card's form starts from the saved settings once they have loaded (kept after that,
	// so edits survive closing and reopening).
	$effect(() => {
		if (open && statesLoaded && !drafts[open]) drafts[open] = { ...(states[open]?.settings ?? {}) };
	});

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
	/** What a portal dry run or import returns (functions/src/lib/portal, `summary`). */
	interface PortalPlan {
		contacts: number;
		stages: Record<string, number>;
		tasks: number;
		wellbeing: number;
		finance: number;
		events: number;
		skipped: string[];
		drift: Record<string, string[]>;
		created?: number;
		moved?: number;
	}
	let stageLabels = $state<Record<string, string>>({});
	/** The last portal dry run or import, shown under its card in sentences. */
	let portalResult = $state<{ kind: 'plan' | 'run'; plan: PortalPlan } | null>(null);
	const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
	/** "7 contacts (2 Fellow (cohort), 1 Targets…), 3 tasks, 2 wellbeing check-ins." */
	function sentences(p: PortalPlan, kind: 'plan' | 'run'): string[] {
		const stages = Object.entries(p.stages)
			.sort((a, b) => b[1] - a[1])
			.map(([id, n]) => `${n} ${stageLabels[id] ?? id}`)
			.join(', ');
		let contacts = count(p.contacts, 'contact', 'contacts');
		if (stages) contacts += ` (${stages})`;
		// Zero counts are left out ("0 meetings" says nothing).
		const parts = [
			contacts,
			...[
				[p.tasks, 'task', 'tasks'],
				[p.wellbeing, 'wellbeing check-in', 'wellbeing check-ins'],
				[p.finance, 'finance record', 'finance records'],
				[p.events, 'meeting', 'meetings']
			]
				.filter(([n]) => n)
				.map(([n, one, many]) => count(n as number, one as string, many as string))
		];
		const out = [`${kind === 'plan' ? 'Would import' : 'Imported'} ${parts.join(', ')}.`];
		if (kind === 'run')
			out.push(`${p.created ?? 0} new contacts, ${p.moved ?? 0} moved to another stage.`);
		const drift = Object.entries(p.drift ?? {});
		if (drift.length)
			out.push(
				`Columns missing in the sheet: ${drift.map(([tab, cols]) => `${tab} (${cols.join(', ')})`).join('; ')}.`
			);
		out.push(p.skipped.length ? `Skipped: ${p.skipped.join('; ')}.` : 'Nothing skipped.');
		return out;
	}
	const preview = () =>
		run('portal:sync.plan', async () => {
			portalResult = {
				kind: 'plan',
				plan: await callAction<PortalPlan>('portal:sync.plan', {}, { timeout: 300_000 })
			};
		});
	// Sync now asks first, with the numbers of a fresh dry run.
	let syncOpen = $state(false);
	let syncPlan = $state<PortalPlan | null>(null);
	let syncError = $state<string | null>(null);
	let syncing = $state(false);
	const askSync = () =>
		run('portal:sync.plan', async () => {
			syncPlan = await callAction<PortalPlan>('portal:sync.plan', {}, { timeout: 300_000 });
			syncError = null;
			syncOpen = true;
		});
	async function syncNow() {
		syncing = true;
		syncError = null;
		try {
			const plan = await callAction<PortalPlan>('portal:sync.run', {}, { timeout: 300_000 });
			portalResult = { kind: 'run', plan };
			syncOpen = false;
		} catch (e) {
			syncError = errorText(e);
		} finally {
			syncing = false;
		}
	}

	/** Setup steps carry **bold** and `code`: split them into parts to render, never as HTML. */
	function rich(step: string): { text: string; kind: 'plain' | 'bold' | 'code' }[] {
		return step
			.split(/(\*\*[^*]+\*\*|`[^`]+`)/)
			.filter(Boolean)
			.map((t) => {
				if (t.startsWith('**') && t.endsWith('**')) return { text: t.slice(2, -2), kind: 'bold' };
				if (t.startsWith('`') && t.endsWith('`')) return { text: t.slice(1, -1), kind: 'code' };
				return { text: t, kind: 'plain' };
			});
	}

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

<!-- Setup steps and setting help: **bold** and `code` as the config writes them. -->
{#snippet richText(text: string)}{#each rich(text) as part, j (j)}{#if part.kind === 'bold'}<strong
				class="text-ink"
			>
				{part.text}
			</strong>{:else if part.kind === 'code'}<code class="rounded bg-canvas px-1 text-xs">
				{part.text}
			</code>{:else}{part.text}{/if}{/each}{/snippet}

<div class="mx-auto max-w-5xl space-y-5">
	<div class="flex items-center justify-between card px-5 py-4">
		<div>
			<div class="eyebrow">Connection map</div>
			<p class="mt-1 text-sm text-ink-soft">
				{working} of {live.length} live connections working{connectors.length > live.length
					? ` · ${connectors.length - live.length} planned`
					: ''}. Passwords and API keys are never stored here; a developer adds them in Google
				Cloud.
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
					<div class="scroll-mt-4 card" id="conn-{c.id}">
						<button
							class="flex w-full items-center gap-4 px-4 py-3 text-left"
							aria-expanded={open === c.id}
							onclick={() => toggle(c)}
						>
							<PlugZap
								class="h-5 w-5 shrink-0 {c.availability === 'live'
									? 'text-primary-600'
									: 'text-line'}"
							/>
							<div class="min-w-0 flex-1">
								<div class="font-semibold">{c.name}</div>
								<div class="truncate text-xs text-ink-soft" title={c.description}>
									{c.description}
								</div>
							</div>
							<div
								class="w-40 shrink-0 truncate text-xs text-ink-soft"
								title="Feeds {c.feeds.join(', ')}"
							>
								Feeds {c.feeds.join(', ')}
							</div>
							<div class="w-28 shrink-0">
								<StatusDot level={LEVEL[status]} label={LABEL[status]} />
							</div>
						</button>

						{#if open === c.id}
							<div class="grid grid-cols-2 gap-6 border-t border-line/60 px-4 py-4 text-sm">
								<p class="col-span-2 text-ink-soft">
									{c.description} <span class="whitespace-nowrap">Feeds {c.feeds.join(', ')}.</span>
								</p>
								<div class="space-y-3">
									<div>
										<div class="label">How to set it up</div>
										<ol class="list-decimal space-y-1 pl-4 text-ink-soft">
											{#each c.setup as step, i (i)}<li>{@render richText(step)}</li>{/each}
										</ol>
									</div>
									{#if c.secrets.length}
										<div>
											<div class="label">Keys (added by a developer)</div>
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
									{#if c.settings.length && !drafts[c.id]}
										<p class="text-xs text-ink-soft">Loading the saved settings…</p>
									{:else if c.settings.length}
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
												<p class="mt-0.5 text-xs text-ink-soft">{@render richText(f.help)}</p>
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
													/> Test connection
												</button>
											{/if}
											{#if c.id === 'portal-sheet' && canWrite}
												<button class="btn-ghost" disabled={busy !== null} onclick={preview}>
													Preview import
												</button>
												<button
													class="btn-ghost"
													disabled={busy !== null || status === 'error'}
													title={status === 'error'
														? 'The connection is failing: fix it and test it first'
														: 'Import the sheet now'}
													onclick={askSync}
												>
													Sync now
												</button>
											{/if}
										</div>
										{#if c.id === 'portal-sheet' && status === 'error' && canWrite}
											<p class="text-xs text-ink-soft">
												Sync now is off while the connection is failing.
											</p>
										{/if}
										{#if c.id === 'portal-sheet' && portalResult}
											<div class="space-y-1 rounded-lg bg-canvas px-3 py-2 text-xs" role="status">
												{#each sentences(portalResult.plan, portalResult.kind) as line, i (i)}<p>
														{line}
													</p>{/each}
											</div>
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

<Modal bind:open={syncOpen} title="Import the portal sheet" width="max-w-md">
	{#if syncPlan}
		<p class="text-sm font-semibold">
			Import {syncPlan.contacts}
			{syncPlan.contacts === 1 ? 'contact' : 'contacts'} now?
		</p>
		<div class="mt-2 space-y-1 text-sm text-ink-soft">
			{#each sentences(syncPlan, 'plan') as line, i (i)}<p>{line}</p>{/each}
		</div>
		<p class="mt-2 text-xs text-ink-soft">
			The sheet is only read. Contacts, tasks and meetings in the Hub are updated to match it.
		</p>
		{#if syncError}<div class="mt-3"><FormError message={syncError} /></div>{/if}
	{/if}
	{#snippet footer()}
		<button class="btn-ghost" onclick={() => (syncOpen = false)}>Cancel</button>
		<button class="btn-primary" disabled={syncing} onclick={syncNow}>
			{syncing ? 'Importing…' : 'Import now'}
		</button>
	{/snippet}
</Modal>
