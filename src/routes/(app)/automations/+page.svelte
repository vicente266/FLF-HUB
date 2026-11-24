<script lang="ts">
	import { onMount } from 'svelte';
	import { collection, query, orderBy, limit } from 'firebase/firestore';
	import Zap from '@lucide/svelte/icons/zap';
	import Clock from '@lucide/svelte/icons/clock';
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
	let states = $state<Record<string, State>>({});
	let recent = $state<Run[]>([]);
	let error = $state<string | null>(null);

	onMount(() => {
		callAction<{ automations: AutomationDef[] }>('automations:config.get').then(
			(r) => (defs = r.automations)
		);
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
		'contact.created': 'When a contact is created',
		'contact.stage': 'When a contact changes stage',
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

	<section class="card">
		<div class="border-b border-line/60 px-4 py-3 font-bold">Recent runs</div>
		<ul class="divide-y divide-line/40">
			{#each recent as r (r.id)}
				<li class="flex items-center gap-3 px-4 py-2 text-sm">
					<span class="h-2 w-2 shrink-0 rounded-full {r.ok ? 'bg-success' : 'bg-danger'}"></span>
					<span class="w-48 shrink-0 font-medium">{name(r.automationId)}</span>
					<span class="min-w-0 flex-1 truncate text-ink-soft">{r.result}</span>
					{#if r.contactId}<a href="/crm/{r.contactId}" class="text-xs text-primary-700">
							Contact
						</a>{/if}
					<span class="w-28 shrink-0 text-right text-xs text-ink-soft">{formatDateTime(r.at)}</span>
				</li>
			{:else}
				<li class="px-4 py-4 text-sm text-ink-soft">No runs yet.</li>
			{/each}
		</ul>
	</section>
</div>
