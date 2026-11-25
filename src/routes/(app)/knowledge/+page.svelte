<script lang="ts">
	import { onMount } from 'svelte';
	import { collection, query, orderBy, limit } from 'firebase/firestore';
	import Plus from '@lucide/svelte/icons/plus';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash from '@lucide/svelte/icons/trash-2';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import { db } from '$lib/firebase';
	import { callAction, errorText } from '$lib/actions';
	import { hasPermission, listen, setTitle, formatDate, formatDateTime } from '$lib/utils';
	import type { KnowledgeEntry, KnowledgeUse, KnowledgeUseOption } from '$lib/types/knowledge';
	import { isExpired } from '$lib/components/knowledge/expiry';
	import KnowledgeModal from '$lib/components/knowledge/KnowledgeModal.svelte';
	import Modal from '$lib/components/shared/Modal.svelte';
	import FormError from '$lib/components/shared/FormError.svelte';
	import Empty from '$lib/components/shared/Empty.svelte';

	setTitle('Knowledge', 'What Claude knows about FLF, and how it uses each entry');

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

	// The choices and the folder are defined in the backend (functions/src/lib/knowledge/config.ts).
	let uses = $state<KnowledgeUseOption[]>([]);
	let folder = $state<{ id: string; url: string } | null>(null);
	onMount(() => {
		callAction<{ uses: KnowledgeUseOption[]; folder: { id: string; url: string } }>(
			'core:knowledge.list'
		)
			.then((r) => {
				uses = r.uses;
				folder = r.folder;
			})
			.catch((e) => (error = errorText(e)));
	});

	const useOf = (e: KnowledgeEntry): KnowledgeUse => e.use ?? 'relevant';
	// In force = not expired; expired ones stay reachable to re-date or delete.
	let current = $derived(entries.filter((e) => !isExpired(e)));
	let expired = $derived(entries.filter((e) => isExpired(e)));
	let counts = $derived({
		always: current.filter((e) => useOf(e) === 'always').length,
		relevant: current.filter((e) => useOf(e) === 'relevant').length,
		off: current.filter((e) => useOf(e) === 'off').length
	});
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

	// How Claude uses an entry, changed right on its row.
	let savingUse = $state<string | null>(null);
	async function setUse(e: KnowledgeEntry, use: string) {
		error = null;
		savingUse = e.id;
		try {
			await callAction('core:knowledge.save', { id: e.id, entry: { use } });
		} catch (err) {
			error = errorText(err);
		} finally {
			savingUse = null;
		}
	}

	// Import the Drive folder now.
	let syncing = $state(false);
	let syncResult = $state<string | null>(null);
	async function sync() {
		syncing = true;
		error = null;
		syncResult = null;
		try {
			const r = await callAction<{
				imported: number;
				added: number;
				updated: number;
				removed: number;
				skipped: string[];
			}>('core:knowledge.sync', {}, { timeout: 300_000 });
			syncResult =
				`${r.imported} documents: ${r.added} new, ${r.updated} updated, ${r.removed} removed.` +
				(r.skipped.length
					? ` Not importable (only Google Docs, text and Markdown): ${r.skipped.join(', ')}.`
					: '');
		} catch (err) {
			error = errorText(err);
		} finally {
			syncing = false;
		}
	}

	// What Claude receives: the "Always" entries, and the titles of the "When relevant" ones.
	let claudeOpen = $state(false);
	let claude = $state<{ active: string; relevant: { label: string; topics: string[] }[] } | null>(
		null
	);
	let claudeError = $state<string | null>(null);
	async function showClaude() {
		claude = null;
		claudeError = null;
		claudeOpen = true;
		try {
			claude = await callAction('core:knowledge.list');
		} catch (e) {
			claudeError = errorText(e);
		}
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
	const USE_TONE: Record<KnowledgeUse, string> = {
		always: 'text-primary-700',
		relevant: 'text-ink',
		off: 'text-ink-soft'
	};
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
				{#if e.source === 'drive'}
					<span class="rounded bg-canvas px-1.5 py-0.5 text-xs font-semibold text-ink-soft">
						Drive{e.truncated ? ' · cut at 50,000 characters' : ''}
					</span>
				{/if}
				{#each e.topics ?? [] as t (t)}
					<span class="rounded border border-line/70 px-1.5 py-0.5 text-xs text-ink-soft">{t}</span>
				{/each}
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
				class="block w-full truncate text-left text-sm hover:text-primary-700 {isExpired(e) ||
				useOf(e) === 'off'
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
		<div class="flex shrink-0 items-center gap-1">
			{#if canWrite && uses.length}
				<select
					class="rounded-md border border-line bg-white px-2 py-1 text-xs font-semibold focus:ring-focus {USE_TONE[
						useOf(e)
					]}"
					title="How Claude uses it"
					disabled={savingUse === e.id}
					value={useOf(e)}
					onchange={(ev) => setUse(e, ev.currentTarget.value)}
				>
					{#each uses as u (u.id)}<option value={u.id}>{u.label}</option>{/each}
				</select>
			{:else}
				<span class="text-xs font-semibold {USE_TONE[useOf(e)]}">
					{uses.find((u) => u.id === useOf(e))?.label ?? useOf(e)}
				</span>
			{/if}
			{#if e.source === 'drive' && e.url}
				<a
					class="btn-ghost px-2"
					href={e.url}
					target="_blank"
					rel="noopener noreferrer"
					aria-label="Open in Drive"
					title="Open in Drive"
				>
					<ExternalLink class="h-4 w-4" />
				</a>
			{/if}
			{#if canWrite}
				<button class="btn-ghost px-2" aria-label="Edit" onclick={() => edit(e)}>
					<Pencil class="h-4 w-4" />
				</button>
				{#if e.source !== 'drive'}
					<button
						class="btn-ghost px-2 text-danger"
						aria-label="Delete"
						disabled={deletingId === e.id}
						onclick={() => remove(e)}
					>
						<Trash class="h-4 w-4" />
					</button>
				{/if}
			{/if}
		</div>
	</li>
{/snippet}

<div class="mx-auto max-w-5xl space-y-4">
	<FormError message={error} />
	<section class="card">
		<div class="flex items-start justify-between gap-4 border-b border-line/60 px-4 py-3">
			<div>
				<div class="font-bold">
					Knowledge
					<span class="font-normal text-ink-soft">
						· {counts.always} always · {counts.relevant} when relevant · {counts.off} off
					</span>
				</div>
				<p class="mt-0.5 text-xs text-ink-soft">
					Facts, offers and messaging about FLF, written here or imported from the Knowledge folder
					in Drive. <strong>Always</strong>: Claude reads it before writing anything about FLF.
					<strong>When relevant</strong>: Claude sees its title and topics and opens it when the
					task needs it. <strong>Off</strong>: never given to Claude. Expired entries are left out.
				</p>
			</div>
			<div class="flex shrink-0 flex-wrap justify-end gap-2">
				<button class="btn-ghost" onclick={showClaude}>What Claude reads</button>
				{#if canWrite}
					<button class="btn-primary" onclick={() => edit(null)}>
						<Plus class="h-4 w-4" /> Add entry
					</button>
				{/if}
			</div>
		</div>
		<div class="flex items-center justify-between gap-3 border-b border-line/60 px-4 py-2 text-xs">
			<span class="flex items-center gap-1.5 text-ink-soft">
				<FolderOpen class="h-3.5 w-3.5" />
				{#if folder}<a
						href={folder.url}
						target="_blank"
						rel="noopener noreferrer"
						class="text-primary-700 hover:underline"
					>
						Knowledge folder in Drive
					</a>{:else}Knowledge folder{/if}: Google Docs, text and Markdown files are imported every
				night (read only).
				{#if syncResult}<span class="text-ink">{syncResult}</span>{/if}
			</span>
			{#if canWrite}
				<button class="btn-ghost shrink-0 text-xs" disabled={syncing} onclick={sync}>
					<RefreshCw class="h-3.5 w-3.5 {syncing ? 'animate-spin' : ''}" />
					{syncing ? 'Importing…' : 'Sync now'}
				</button>
			{/if}
		</div>

		{#if loading}
			<p class="px-4 py-4 text-sm text-ink-soft">Loading…</p>
		{:else}
			<ul class="divide-y divide-line/40">
				{#each current as e (e.id)}
					{@render row(e)}
				{:else}
					<li class="px-4 py-2">
						<Empty title={entries.length ? 'Every entry has expired' : 'No knowledge yet'}>
							{entries.length
								? 'Change their expiry date or delete them below.'
								: 'Add what Claude should know (the Fellowship, the Pledge, the pitch for funds and universities, current offers), or put documents in the Knowledge folder and press Sync now.'}
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

<KnowledgeModal bind:open={editOpen} entry={editing} {uses} />

<Modal bind:open={previewOpen} title={preview?.label || 'Entry'} width="max-w-2xl">
	{#if preview}
		<p class="text-sm whitespace-pre-wrap">{preview.description}</p>
	{/if}
</Modal>

<Modal bind:open={claudeOpen} title="What Claude reads" width="max-w-3xl">
	{#if claudeError}
		<p class="text-sm text-danger">{claudeError}</p>
	{:else if claude === null}
		<p class="text-sm text-ink-soft">Loading…</p>
	{:else}
		<p class="mb-2 text-xs text-ink-soft">
			<strong>Always:</strong> the text Claude receives before writing about FLF, inside a note telling
			it to follow it for facts and wording.
		</p>
		<pre
			class="max-h-[45vh] overflow-auto rounded-lg bg-canvas px-3 py-2 text-xs whitespace-pre-wrap">{claude.active ||
				'(nothing set to Always)'}</pre>
		<p class="mt-3 mb-1 text-xs text-ink-soft">
			<strong>When relevant:</strong> Claude sees only these titles and topics, and asks for the text
			when the task needs it.
		</p>
		{#if claude.relevant.length}
			<ul class="space-y-0.5 text-sm">
				{#each claude.relevant as r (r.label + r.topics.join())}
					<li>
						{r.label}{#if r.topics.length}<span class="text-xs text-ink-soft">
								· {r.topics.join(', ')}
							</span>{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="text-sm text-ink-soft">(nothing set to When relevant)</p>
		{/if}
	{/if}
</Modal>
