<script lang="ts">
	import { collection, query, orderBy, limit } from 'firebase/firestore';
	import Plus from '@lucide/svelte/icons/plus';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash from '@lucide/svelte/icons/trash-2';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { db } from '$lib/firebase';
	import { callAction, errorText } from '$lib/actions';
	import { hasPermission, listen, setTitle, formatDate, formatDateTime } from '$lib/utils';
	import type { KnowledgeEntry } from '$lib/types/knowledge';
	import { isExpired } from '$lib/components/knowledge/expiry';
	import KnowledgeModal from '$lib/components/knowledge/KnowledgeModal.svelte';
	import Modal from '$lib/components/shared/Modal.svelte';
	import FormError from '$lib/components/shared/FormError.svelte';
	import Empty from '$lib/components/shared/Empty.svelte';

	setTitle('Knowledge', 'What Claude knows about FLF before it writes anything');

	const canWrite = hasPermission('knowledge.any.write');
	let entries = $state<KnowledgeEntry[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	$effect(() =>
		listen<KnowledgeEntry>(
			query(collection(db, 'knowledge'), orderBy('createdAt'), limit(200)),
			(rows) => {
				entries = rows;
				loading = false;
			},
			() => {
				error = "Couldn't load the knowledge entries. Reload the page to try again.";
				loading = false;
			}
		)
	);

	// Active entries are what Claude reads; expired ones stay reachable to re-date or delete.
	let active = $derived(entries.filter((e) => !isExpired(e)));
	let expired = $derived(entries.filter((e) => isExpired(e)));
	let showExpired = $state(false);

	let editOpen = $state(false);
	let editing = $state<KnowledgeEntry | null>(null);
	function edit(e: KnowledgeEntry | null) {
		editing = e;
		editOpen = true;
	}

	let previewOpen = $state(false);
	let preview = $state<KnowledgeEntry | null>(null);
	function open(e: KnowledgeEntry) {
		preview = e;
		previewOpen = true;
	}

	let deletingId = $state<string | null>(null);
	async function remove(e: KnowledgeEntry) {
		if (
			deletingId ||
			!confirm(`Delete "${e.label || firstLine(e)}"? Claude stops using it. This cannot be undone.`)
		)
			return;
		error = null;
		deletingId = e.id;
		try {
			await callAction('core:knowledge.delete', { id: e.id });
		} catch (err) {
			error = errorText(err);
		} finally {
			deletingId = null;
		}
	}

	const firstLine = (e: KnowledgeEntry) => e.description.split('\n').find((l) => l.trim()) ?? '';
	// `YYYY-MM-DD` read as that calendar day (noon UTC), whatever the viewer's time zone.
	const day = (iso: string) => formatDate(new Date(`${iso}T12:00:00Z`));
</script>

{#snippet row(e: KnowledgeEntry)}
	<li class="flex items-start gap-4 px-4 py-3">
		<div class="min-w-0 flex-1">
			<div class="mb-1 flex flex-wrap items-center gap-1.5">
				{#if e.label}
					<span class="rounded bg-primary-50 px-1.5 py-0.5 text-xs font-semibold text-primary-700">
						{e.label}
					</span>
				{/if}
				{#if e.expiredAt}
					<span
						class="rounded px-1.5 py-0.5 text-xs font-semibold {isExpired(e)
							? 'bg-canvas text-danger'
							: 'bg-amber-50 text-amber-800'}"
					>
						{isExpired(e) ? 'Expired' : 'Until'}
						{day(e.expiredAt)}
					</span>
				{/if}
			</div>
			<button
				type="button"
				class="block w-full truncate text-left text-sm hover:text-primary-700 {isExpired(e)
					? 'line-through opacity-60'
					: ''}"
				title="Open the full text"
				onclick={() => open(e)}
			>
				{firstLine(e)}
			</button>
			{#if e.updatedBy}
				<div class="mt-0.5 text-xs text-ink-soft">
					{e.updatedBy} · {formatDateTime(e.updatedAt)}
				</div>
			{/if}
		</div>
		{#if canWrite}
			<div class="flex shrink-0 gap-1">
				<button class="btn-ghost px-2" aria-label="Edit" onclick={() => edit(e)}>
					<Pencil class="h-4 w-4" />
				</button>
				<button
					class="btn-ghost px-2 text-danger"
					aria-label="Delete"
					disabled={deletingId === e.id}
					onclick={() => remove(e)}
				>
					<Trash class="h-4 w-4" />
				</button>
			</div>
		{/if}
	</li>
{/snippet}

<div class="mx-auto max-w-4xl space-y-4">
	<FormError message={error} />
	<section class="card">
		<div class="flex items-start justify-between gap-4 border-b border-line/60 px-4 py-3">
			<div>
				<div class="font-bold">
					Knowledge <span class="font-normal text-ink-soft">({active.length} active)</span>
				</div>
				<p class="mt-0.5 text-xs text-ink-soft">
					Facts, offers and messaging about FLF. Claude reads the active entries before it drafts an
					email, a pitch or a reply; an entry with an expiry date stops being used the day after.
				</p>
			</div>
			{#if canWrite}
				<button class="btn-primary shrink-0" onclick={() => edit(null)}>
					<Plus class="h-4 w-4" /> Add entry
				</button>
			{/if}
		</div>

		{#if loading}
			<p class="px-4 py-4 text-sm text-ink-soft">Loading…</p>
		{:else}
			<ul class="divide-y divide-line/40">
				{#each active as e (e.id)}
					{@render row(e)}
				{:else}
					<li class="px-4 py-2">
						<Empty title={entries.length ? 'Every entry has expired' : 'No knowledge yet'}>
							{entries.length
								? 'Change their expiry date or delete them below.'
								: 'Add what Claude should know: the Fellowship, the Pledge, the pitch for funds and universities, current offers.'}
						</Empty>
					</li>
				{/each}
				{#if expired.length}
					<li>
						<button
							type="button"
							class="flex w-full items-center gap-1.5 px-4 py-2 text-xs font-semibold text-ink-soft hover:bg-canvas"
							onclick={() => (showExpired = !showExpired)}
						>
							{#if showExpired}<ChevronDown class="h-3.5 w-3.5" />{:else}<ChevronRight
									class="h-3.5 w-3.5"
								/>{/if}
							{showExpired ? 'Hide' : 'Show'}
							{expired.length} expired · not given to Claude
						</button>
					</li>
					{#if showExpired}
						{#each expired as e (e.id)}
							{@render row(e)}
						{/each}
					{/if}
				{/if}
			</ul>
		{/if}
	</section>
</div>

<KnowledgeModal bind:open={editOpen} entry={editing} />

<Modal bind:open={previewOpen} title={preview?.label || 'Entry'} width="max-w-2xl">
	{#if preview}
		<p class="text-sm whitespace-pre-wrap">{preview.description}</p>
	{/if}
</Modal>
