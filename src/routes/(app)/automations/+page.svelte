<script lang="ts">
	import { onMount } from 'svelte';
	import { collection, query, orderBy, limit } from 'firebase/firestore';
	import Zap from '@lucide/svelte/icons/zap';
	import Clock from '@lucide/svelte/icons/clock';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import { db } from '$lib/firebase';
	import { callAction, errorText } from '$lib/actions';
	import { hasPermission, listen, setTitle, formatDateTime } from '$lib/utils';
	import type { AutomationDef } from '$lib/types/connections';
	import FormError from '$lib/components/shared/FormError.svelte';

	setTitle('Automations', 'What the Hub does on its own');

	interface State {
		id: string;
		enabled?: boolean;
		lastRunAt?: unknown;
		lastError?: string | null;
		runs?: number;
		errors?: number;
	}
	interface Run {
		id: string;
		automationId: string;
		contactId: string | null;
		result: string;
		ok: boolean;
		at: unknown;
	}

	const canWrite = hasPermission('automations.any.write');
	let defs = $state<AutomationDef[]>([]);
	interface N8nAutomation {
		workflowId: string;
		name: string;
		description: string;
		when: string;
	}
	let n8nDefs = $state<N8nAutomation[]>([]);
	let states = $state<Record<string, State>>({});
	let recent = $state<Run[]>([]);
	let error = $state<string | null>(null);

	interface N8nWorkflow {
		id: string;
		name: string;
		active: boolean;
		tags: string[];
		flf: boolean;
		lastRun: { at: string | null; status: string } | null;
		errors24h: number;
		lastErrorAt: string | null;
		url: string;
	}
	let n8n = $state<N8nWorkflow[] | null>(null);
	let n8nError = $state<string | null>(null);
	let flfOnly = $state(false);
	let shown = $derived((n8n ?? []).filter((w) => !flfOnly || w.flf));
	function loadN8n() {
		n8nError = null;
		callAction<{ workflows: N8nWorkflow[] }>('automations:n8n.workflows')
			.then((r) => (n8n = r.workflows))
			.catch((e) => (n8nError = errorText(e)));
	}
	const RUN_TONE: Record<string, string> = {
		success: 'bg-success',
		error: 'bg-danger',
		crashed: 'bg-danger',
		running: 'bg-primary-500',
		waiting: 'bg-amber-400'
	};

	onMount(() => {
		callAction<{ automations: AutomationDef[]; n8n: N8nAutomation[] }>(
			'automations:config.get'
		).then((r) => {
			defs = r.automations;
			n8nDefs = r.n8n;
		});
		loadN8n();
		const unsubs = [
			listen<State>(
				collection(db, 'automation'),
				(rows) => (states = Object.fromEntries(rows.map((r) => [r.id, r])))
			),
			listen<Run>(
				query(collection(db, 'automationRun'), orderBy('at', 'desc'), limit(30)),
				(rows) => (recent = rows)
			)
		];
		return () => unsubs.forEach((u) => u());
	});

	const isOn = (d: AutomationDef) => states[d.id]?.enabled ?? d.defaultEnabled;
	const name = (id: string) => defs.find((d) => d.id === id)?.name ?? id;

	async function toggle(d: AutomationDef) {
		try {
			await callAction('automations:toggle', { id: d.id, enabled: !isOn(d) });
		} catch (e) {
			error = errorText(e);
		}
	}

	const TRIGGER = {
		'contact.stage': 'When a contact changes stage',
		'contact.nextStep': 'When a contact’s next step is set',
		meeting: 'After a new meeting (portal sheet sync)',
		schedule: 'On a schedule'
	};
</script>

<div class="mx-auto max-w-5xl space-y-4">
	<FormError message={error} />
	<div class="grid grid-cols-2 gap-3">
		{#each defs as d (d.id)}
			{@const s = states[d.id]}
			<section class="flex flex-col card px-4 py-3">
				<div class="flex items-start justify-between gap-3">
					<div>
						<h3 class="font-bold">{d.name}</h3>
						<div class="mt-0.5 flex items-center gap-1 text-xs text-primary-700">
							{#if d.trigger === 'schedule'}<Clock class="h-3.5 w-3.5" /> {d.schedule}{:else}<Zap
									class="h-3.5 w-3.5"
								/>
								{TRIGGER[d.trigger]}{/if}
						</div>
					</div>
					<button
						role="switch"
						aria-checked={isOn(d)}
						aria-label="Toggle {d.name}"
						disabled={!canWrite}
						onclick={() => toggle(d)}
						class="relative h-5 w-9 shrink-0 rounded-full transition {isOn(d)
							? 'bg-primary-600'
							: 'bg-line'}"
					>
						<span
							class="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all {isOn(d)
								? 'left-4.5'
								: 'left-0.5'}"
						></span>
					</button>
				</div>
				<p class="mt-2 flex-1 text-sm text-ink-soft">{d.description}</p>
				{#if d.uses.length}
					<p class="mt-2 text-xs text-ink-soft">
						Uses: {#each d.uses as u, i (u)}<a href="/connections" class="text-primary-700">
								{u}
							</a>{i < d.uses.length - 1 ? ', ' : ''}{/each}
					</p>
				{/if}
				<div class="mt-3 flex justify-between border-t border-line/50 pt-2 text-xs text-ink-soft">
					<span>
						Last run {formatDateTime(s?.lastRunAt)} · {s?.runs ?? 0}
						{s?.runs === 1 ? 'run' : 'runs'}
					</span>
					{#if s?.lastError}<span class="truncate pl-2 text-danger" title={s.lastError}>
							{s.lastError}
						</span>{/if}
				</div>
			</section>
		{/each}
	</div>

	{#if n8nDefs.length}
		<h2 class="pt-2 text-sm font-bold text-ink-soft">Run by n8n · read only here</h2>
		<div class="grid grid-cols-2 gap-3">
			{#each n8nDefs as a (a.name)}
				{@const w = n8n?.find((x) => x.id === a.workflowId)}
				<section class="flex flex-col card px-4 py-3">
					<div class="flex items-start justify-between gap-3">
						<div>
							<h3 class="font-bold">{a.name}</h3>
							<div class="mt-0.5 flex items-center gap-1 text-xs text-primary-700">
								<Clock class="h-3.5 w-3.5" />
								{a.when}
							</div>
						</div>
						{#if w}
							<a
								href={w.url}
								target="_blank"
								rel="noopener noreferrer"
								class="flex shrink-0 items-center gap-1 text-xs text-primary-700"
							>
								Open in n8n <ExternalLink class="h-3 w-3" />
							</a>
						{/if}
					</div>
					<p class="mt-2 flex-1 text-sm text-ink-soft">{a.description}</p>
					<div class="mt-3 flex justify-between border-t border-line/50 pt-2 text-xs text-ink-soft">
						{#if !n8n}
							<span>{n8nError ? "Can't reach n8n. Check it on Health." : 'Reading n8n…'}</span>
						{:else if !w}
							<span class="text-danger">
								Not found in n8n. It may have been renamed or deleted.
							</span>
						{:else}
							<span class="flex items-center gap-1.5">
								<span class="h-2 w-2 rounded-full {w.active ? 'bg-success' : 'bg-line'}"></span>
								{w.active ? 'Active' : 'Inactive'}
								{#if w.lastRun}· last run {formatDateTime(w.lastRun.at)}{:else}· no saved run (n8n
									may keep only failures){/if}
							</span>
							<span class={w.errors24h ? 'font-semibold text-danger' : ''}>
								{w.errors24h ? `${w.errors24h} failed (24h)` : 'No failures (24h)'}
							</span>
						{/if}
					</div>
				</section>
			{/each}
		</div>
	{/if}

	<section class="card">
		<div class="flex items-center justify-between border-b border-line/60 px-4 py-3">
			<div>
				<span class="font-bold">All n8n workflows</span>
				{#if n8n}<span class="ml-2 text-xs text-ink-soft">
						{n8n.filter((w) => w.active).length} active of {n8n.length} · read only
					</span>{/if}
			</div>
			<div class="flex items-center gap-2">
				<div class="flex rounded-lg border border-line/70 bg-white p-0.5">
					{#each [[false, 'All'], [true, 'FLF']] as [value, label] (label)}
						<button
							class="rounded-md px-3 py-1 text-xs font-semibold {flfOnly === value
								? 'bg-primary-600 text-white'
								: 'text-ink-soft'}"
							onclick={() => (flfOnly = value as boolean)}
						>
							{label}
						</button>
					{/each}
				</div>
				<button class="btn-ghost text-xs" onclick={loadN8n}>Refresh</button>
			</div>
		</div>
		{#if n8nError}
			<p class="px-4 py-4 text-sm text-danger">{n8nError}</p>
		{:else if !n8n}
			<p class="px-4 py-4 text-sm text-ink-soft">Reading n8n…</p>
		{:else}
			<ul class="divide-y divide-line/40">
				{#each shown as w (w.id)}
					<li class="flex items-center gap-3 px-4 py-2 text-sm">
						<span
							class="h-2 w-2 shrink-0 rounded-full {w.active ? 'bg-success' : 'bg-line'}"
							title={w.active ? 'Active' : 'Inactive'}
						></span>
						<a
							href={w.url}
							target="_blank"
							rel="noopener noreferrer"
							class="flex min-w-0 flex-1 items-center gap-1 font-medium hover:text-primary-700"
						>
							<span class="truncate">{w.name}</span>
							<ExternalLink class="h-3 w-3 shrink-0 text-ink-soft" />
						</a>
						{#if w.flf}<span class="text-xs font-semibold text-primary-700">FLF</span>{/if}
						<span class="w-20 shrink-0 text-xs text-ink-soft">
							{w.active ? 'Active' : 'Inactive'}
						</span>
						<span class="flex w-44 shrink-0 items-center gap-1.5 text-xs text-ink-soft">
							{#if w.lastRun}
								<span class="h-1.5 w-1.5 rounded-full {RUN_TONE[w.lastRun.status] ?? 'bg-line'}"
								></span>
								{w.lastRun.status} · {formatDateTime(w.lastRun.at)}
							{:else}
								{w.flf ? 'No saved run' : 'None in the latest 250 runs'}
							{/if}
						</span>
						<span
							class="w-28 shrink-0 text-right text-xs {w.errors24h
								? 'font-semibold text-danger'
								: 'text-ink-soft'}"
							title={w.lastErrorAt ? `Last failure ${formatDateTime(w.lastErrorAt)}` : ''}
						>
							{w.errors24h ? `${w.errors24h} failed (24h)` : 'No failures'}
						</span>
					</li>
				{:else}
					<li class="px-4 py-4 text-sm text-ink-soft">No workflows.</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="card">
		<div class="border-b border-line/60 px-4 py-3 font-bold">Recent runs</div>
		<ul class="divide-y divide-line/40">
			{#each recent as r (r.id)}
				<li class="flex items-center gap-3 px-4 py-2 text-sm">
					<span class="h-2 w-2 shrink-0 rounded-full {r.ok ? 'bg-success' : 'bg-danger'}"></span>
					<span class="w-48 shrink-0 font-medium">{name(r.automationId)}</span>
					<span class="min-w-0 flex-1 truncate text-ink-soft">{r.result}</span>
					{#if r.contactId}<a href="/crm/{r.contactId}" class="text-xs text-primary-700">
							Open contact
						</a>{/if}
					<span class="w-28 shrink-0 text-right text-xs text-ink-soft">{formatDateTime(r.at)}</span>
				</li>
			{:else}
				<li class="px-4 py-4 text-sm text-ink-soft">
					No runs yet. They appear here when an automation that is on runs.
				</li>
			{/each}
		</ul>
	</section>
</div>
