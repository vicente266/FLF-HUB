<script lang="ts">
	// The Gaps tab of Knowledge: what Claude (or a person) found missing, contradictory or out of
	// date, to fix and resolve. The page owns the open list (it also counts the tab's badge).
	import { collection, query, where, orderBy, limit } from 'firebase/firestore';
	import Check from '@lucide/svelte/icons/check';
	import Plus from '@lucide/svelte/icons/plus';
	import { db } from '$lib/firebase';
	import { callAction, errorText } from '$lib/actions';
	import { listen, formatDateTime } from '$lib/utils';
	import type { KnowledgeEntry, KnowledgeGap, KnowledgeOption } from '$lib/types/knowledge';
	import Modal from '$lib/components/shared/Modal.svelte';
	import FormError from '$lib/components/shared/FormError.svelte';
	import Empty from '$lib/components/shared/Empty.svelte';
	import { titleOf } from './words';

	let {
		gaps,
		entries,
		kinds,
		canWrite,
		onOpen
	}: {
		/** The open gaps, newest first. */
		gaps: KnowledgeGap[];
		/** The entries this person can see, to name and open the ones a gap links. */
		entries: KnowledgeEntry[];
		kinds: KnowledgeOption[];
		canWrite: boolean;
		onOpen: (e: KnowledgeEntry) => void;
	} = $props();

	const KIND_TONE: Record<string, string> = {
		missing: 'bg-warning/10 text-warning',
		conflict: 'bg-danger/10 text-danger',
		outdated: 'bg-canvas text-ink-soft'
	};
	const kindLabel = (id: string) => kinds.find((k) => k.id === id)?.label ?? id;
	let byId = $derived(new Map(entries.map((e) => [e.id, e])));

	// Resolved gaps: read only when asked for (same index as the open ones).
	let showResolved = $state(false);
	let resolved = $state<KnowledgeGap[]>([]);
	$effect(() => {
		if (!showResolved) return;
		return listen<KnowledgeGap>(
			query(
				collection(db, 'knowledgeGap'),
				where('status', '==', 'resolved'),
				orderBy('createdAt', 'desc'),
				limit(50)
			),
			(rows) => (resolved = rows)
		);
	});
	let rows = $derived(showResolved ? resolved : gaps);

	let error = $state<string | null>(null);

	// Resolve, with an optional note on what was done.
	let resolveOpen = $state(false);
	let resolving = $state<KnowledgeGap | null>(null);
	let resolveNote = $state('');
	let busy = $state(false);
	function askResolve(g: KnowledgeGap) {
		resolving = g;
		resolveNote = '';
		error = null;
		resolveOpen = true;
	}
	async function resolve() {
		if (!resolving) return;
		busy = true;
		error = null;
		try {
			await callAction('core:knowledge.gap.resolve', {
				id: resolving.id,
				note: resolveNote.trim()
			});
			resolveOpen = false;
		} catch (e) {
			error = errorText(e);
		} finally {
			busy = false;
		}
	}

	// A person reports a gap too (anyone who reads Knowledge, as Claude does).
	let reportOpen = $state(false);
	let draft = $state({ kind: 'missing', note: '', entryIds: [] as string[], query: '' });
	function askReport() {
		draft = { kind: 'missing', note: '', entryIds: [], query: '' };
		error = null;
		reportOpen = true;
	}
	async function report() {
		if (!draft.note.trim()) {
			error = 'Say what is missing or wrong.';
			return;
		}
		busy = true;
		error = null;
		try {
			await callAction('core:knowledge.gap.report', {
				kind: draft.kind,
				note: draft.note.trim(),
				entryIds: draft.entryIds,
				query: draft.query.trim()
			});
			reportOpen = false;
		} catch (e) {
			error = errorText(e);
		} finally {
			busy = false;
		}
	}
</script>

<div class="mx-auto max-w-7xl space-y-4">
	<div class="flex flex-wrap items-center justify-between gap-4">
		<div class="flex items-baseline gap-6">
			<span><span class="text-3xl font-bold">{gaps.length}</span> open</span>
			<span class="text-xs text-ink-soft">
				Reported by Claude while it reads Knowledge, or by the team. Fix the entry (or add one),
				then resolve the gap.
			</span>
		</div>
		<div class="flex items-center gap-3 text-sm">
			<label class="flex items-center gap-1.5 text-ink-soft">
				<input type="checkbox" bind:checked={showResolved} /> Show resolved
			</label>
			<button class="btn-primary text-xs" onclick={askReport}>
				<Plus class="h-4 w-4" /> Report a gap
			</button>
		</div>
	</div>
	{#if !resolveOpen && !reportOpen}<FormError message={error} />{/if}

	<section class="divide-y divide-line/40 card">
		{#each rows as g (g.id)}
			<article class="flex items-start gap-4 px-4 py-3 text-sm">
				<span
					class="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold {KIND_TONE[g.kind] ??
						''}"
				>
					{kindLabel(g.kind)}
				</span>
				<div class="min-w-0 flex-1">
					<p class="whitespace-pre-wrap">{g.note}</p>
					{#if g.query}
						<p class="mt-0.5 text-xs text-ink-soft">Looking for: “{g.query}”</p>
					{/if}
					{#if g.entryIds?.length}
						<div class="mt-1 flex flex-wrap gap-x-3 text-xs">
							{#each g.entryIds as id (id)}
								{@const e = byId.get(id)}
								{#if e}
									<button
										class="font-semibold text-primary-700 hover:underline"
										onclick={() => onOpen(e)}
									>
										{titleOf(e)}
									</button>
								{:else}
									<span class="text-ink-soft" title="Deleted, or not visible to you">
										(an entry you can’t see)
									</span>
								{/if}
							{/each}
						</div>
					{/if}
					<p class="mt-1 text-xs text-ink-soft">
						<!-- reportedBy already ends "· via Claude" for Claude's reports. -->
						{g.reportedBy} · {formatDateTime(g.createdAt)}
						{#if (g.count ?? 1) > 1}
							· reported {g.count} times, last {formatDateTime(g.lastReportedAt)}
						{/if}
					</p>
					{#if g.status === 'resolved'}
						<p class="mt-1 text-xs text-success">
							Resolved by {g.resolvedBy} · {formatDateTime(g.resolvedAt)}{g.resolution
								? `: ${g.resolution}`
								: ''}
						</p>
					{/if}
				</div>
				{#if canWrite && g.status === 'open'}
					<button class="btn-ghost shrink-0 text-xs" onclick={() => askResolve(g)}>
						<Check class="h-3.5 w-3.5" /> Resolve
					</button>
				{/if}
			</article>
		{:else}
			<div class="px-4 py-2">
				<Empty title={showResolved ? 'Nothing resolved yet' : 'No open gaps'}>
					When Claude can't find what a task needs in Knowledge, or finds entries that disagree, it
					reports it here.
				</Empty>
			</div>
		{/each}
	</section>
</div>

<Modal bind:open={resolveOpen} title="Resolve gap">
	<div class="space-y-3">
		<p class="text-sm whitespace-pre-wrap">{resolving?.note}</p>
		<div>
			<label class="label" for="gap-resolution">
				What was done <span class="font-normal">(optional)</span>
			</label>
			<textarea
				id="gap-resolution"
				class="input"
				rows="3"
				maxlength="1000"
				bind:value={resolveNote}
				placeholder="e.g. Added the 2026 prices to the Offer entry."></textarea>
		</div>
		<FormError message={error} />
	</div>
	{#snippet footer()}
		<button class="btn-ghost" onclick={() => (resolveOpen = false)}>Cancel</button>
		<button class="btn-primary" disabled={busy} onclick={resolve}>
			<Check class="h-4 w-4" />
			{busy ? 'Resolving…' : 'Resolve'}
		</button>
	{/snippet}
</Modal>

<Modal bind:open={reportOpen} title="Report a gap" dirty={!!draft.note.trim()}>
	<div class="space-y-3">
		<div>
			<label class="label" for="gap-kind">Kind</label>
			<select id="gap-kind" class="input" bind:value={draft.kind}>
				{#each kinds as k (k.id)}<option value={k.id}>{k.label}</option>{/each}
			</select>
			<p class="mt-1 text-xs text-ink-soft">{kinds.find((k) => k.id === draft.kind)?.help}</p>
		</div>
		<div>
			<label class="label" for="gap-note">What is missing or wrong</label>
			<textarea
				id="gap-note"
				class="input"
				rows="4"
				maxlength="1000"
				bind:value={draft.note}
				placeholder="e.g. Nothing says what the Pledge is for Fellows outside the EU."></textarea>
		</div>
		<div>
			<label class="label" for="gap-entries">
				Entries <span class="font-normal">
					({draft.kind === 'missing' ? 'optional' : 'at least one'}; Ctrl/⌘-click for several)
				</span>
			</label>
			<select id="gap-entries" class="input" multiple size="6" bind:value={draft.entryIds}>
				{#each entries as e (e.id)}<option value={e.id}>{titleOf(e)}</option>{/each}
			</select>
		</div>
		<div>
			<label class="label" for="gap-query">
				Question or search <span class="font-normal">(optional)</span>
			</label>
			<input id="gap-query" class="input" maxlength="300" bind:value={draft.query} />
		</div>
		<FormError message={error} />
	</div>
	{#snippet footer()}
		<button class="btn-ghost" onclick={() => (reportOpen = false)}>Cancel</button>
		<button class="btn-primary" disabled={busy} onclick={report}>
			{busy ? 'Reporting…' : 'Report'}
		</button>
	{/snippet}
</Modal>
