<script lang="ts">
	import { onMount } from 'svelte';
	import { collection, query, orderBy, limit, where } from 'firebase/firestore';
	import Plus from '@lucide/svelte/icons/plus';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash from '@lucide/svelte/icons/trash-2';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import { db } from '$lib/firebase';
	import { callAction, errorText } from '$lib/actions';
	import { hasPermission, listen, setTitle, formatDate } from '$lib/utils';
	import { me } from '$lib/stores';
	import type {
		KnowledgeEntry,
		KnowledgeOption,
		KnowledgeUse,
		KnowledgeUseOption
	} from '$lib/types/knowledge';
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

	// Restricted entries are for admins: everyone else asks only for the others (the rules check it).
	$effect(() =>
		listen<KnowledgeEntry>(
			$me?.role === 'admin'
				? query(collection(db, 'knowledge'), orderBy('createdAt'), limit(200))
				: query(
						collection(db, 'knowledge'),
						where('audience', 'in', ['external', 'internal']),
						orderBy('createdAt'),
						limit(200)
					),
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
	// Types in order of precedence: the first one wins when two entries disagree.
	let types = $state<KnowledgeOption[]>([]);
	let audiences = $state<KnowledgeOption[]>([]);
	let reviewEvery = $state<number[]>([]);
	let folder = $state<{ id: string; url: string } | null>(null);
	onMount(() => {
		callAction<{
			uses: KnowledgeUseOption[];
			types: KnowledgeOption[];
			audiences: KnowledgeOption[];
			reviewEvery: number[];
			folder: { id: string; url: string };
		}>('core:knowledge.list')
			.then((r) => {
				uses = r.uses;
				types = r.types;
				audiences = r.audiences;
				reviewEvery = r.reviewEvery;
				folder = r.folder;
			})
			.catch((e) => (error = errorText(e)));
	});

	const approved = (e: KnowledgeEntry) => e.status === 'approved';
	// As the backend applies it: a draft set to Always is read only when relevant.
	const useOf = (e: KnowledgeEntry): KnowledgeUse => {
		const use = e.use ?? 'relevant';
		return use === 'always' && !approved(e) ? 'relevant' : use;
	};
	const todayIso = () => new Date().toISOString().slice(0, 10);
	function reviewDue(e: KnowledgeEntry): boolean {
		if (!approved(e)) return false;
		if (!e.lastReviewed) return true;
		const [y, m, dd] = e.lastReviewed.split('-').map(Number);
		const due = new Date(Date.UTC(y, m - 1 + (e.reviewEvery ?? 6), dd));
		return due.toISOString().slice(0, 10) <= todayIso();
	}
	// In force = not expired; expired ones stay reachable to re-date or delete.
	let current = $derived(entries.filter((e) => !isExpired(e)));
	let expired = $derived(entries.filter((e) => isExpired(e)));
	let counts = $derived({
		always: current.filter((e) => useOf(e) === 'always').length,
		relevant: current.filter((e) => useOf(e) === 'relevant').length,
		off: current.filter((e) => useOf(e) === 'off').length
	});
	// Filters and sort, all on this one table (no extra clicks).
	let search = $state('');
	let typeFilter = $state('');
	let audienceFilter = $state('');
	let statusFilter = $state<'' | 'approved' | 'draft' | 'review' | 'nouse'>('');
	let useFilter = $state('');
	let showExpired = $state(false);
	let sortBy = $state<'rank' | 'updated'>('rank');
	const typeIndex = (e: KnowledgeEntry) => {
		const i = types.findIndex((t) => t.id === (e.type ?? 'other'));
		return i < 0 ? types.length : i;
	};
	const updatedMs = (e: KnowledgeEntry) =>
		(e.updatedAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
	let stats = $derived({
		total: current.length,
		approved: current.filter(approved).length,
		draft: current.filter((e) => !approved(e)).length,
		review: current.filter(reviewDue).length,
		noUseWhen: current.filter((e) => !e.useWhen).length
	});
	let rows = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return (showExpired ? entries : current)
			.filter((e) => !typeFilter || (e.type ?? 'other') === typeFilter)
			.filter((e) => !audienceFilter || (e.audience ?? 'internal') === audienceFilter)
			.filter((e) => !useFilter || useOf(e) === useFilter)
			.filter((e) => {
				if (statusFilter === 'approved') return approved(e);
				if (statusFilter === 'draft') return !approved(e);
				if (statusFilter === 'review') return reviewDue(e);
				if (statusFilter === 'nouse') return !e.useWhen;
				return true;
			})
			.filter(
				(e) =>
					!q ||
					[e.label, e.useWhen, e.description.slice(0, 2000), ...(e.topics ?? [])]
						.join(' ')
						.toLowerCase()
						.includes(q)
			)
			.sort((a, b) =>
				sortBy === 'updated'
					? updatedMs(b) - updatedMs(a)
					: typeIndex(a) - typeIndex(b) ||
						Number(approved(b)) - Number(approved(a)) ||
						(b.lastReviewed ?? '').localeCompare(a.lastReviewed ?? '')
			);
	});

	// Approving and reviewing are for people (the backend refuses them via Claude).
	let approving = $state<string | null>(null);
	async function setCard(e: KnowledgeEntry, card: Record<string, unknown>) {
		error = null;
		approving = e.id;
		try {
			await callAction('core:knowledge.save', { id: e.id, entry: card });
		} catch (err) {
			error = errorText(err);
		} finally {
			approving = null;
		}
	}

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
	let claude = $state<{
		active: string;
		relevant: { label: string; topics: string[]; useWhen: string }[];
	} | null>(null);
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

<div class="mx-auto max-w-7xl space-y-4">
	<FormError message={error} />

	<!-- Summary, source and actions on one line. -->
	<div class="flex flex-wrap items-end justify-between gap-4">
		<div class="flex flex-wrap items-baseline gap-6">
			<span><span class="text-3xl font-bold">{stats.total}</span> documents</span>
			<span><span class="text-3xl font-bold text-success">{stats.approved}</span> approved</span>
			<span><span class="text-3xl font-bold">{stats.draft}</span> draft</span>
			{#if stats.review}<span>
					<span class="text-3xl font-bold text-amber-700">{stats.review}</span> review due
				</span>{/if}
			<span class="text-xs text-ink-soft">
				Claude: {counts.always} always · {counts.relevant} when relevant · {counts.off} off
			</span>
		</div>
		<div class="flex flex-wrap items-center gap-2 text-xs">
			<span class="flex items-center gap-1.5 text-ink-soft">
				<FolderOpen class="h-3.5 w-3.5" />
				{#if folder}<a
						href={folder.url}
						target="_blank"
						rel="noopener noreferrer"
						class="text-primary-700 hover:underline"
					>
						Knowledge folder in Drive
					</a>{:else}Knowledge folder{/if} · imported every night
			</span>
			{#if stats.noUseWhen && canWrite}
				<button
					class="font-semibold text-amber-700 hover:underline"
					onclick={() => (statusFilter = 'nouse')}
					title="Entries without a Use when line: Claude can't tell when to read them"
				>
					{stats.noUseWhen} without “Use when”
				</button>
			{/if}
			{#if canWrite}
				<button class="btn-ghost text-xs" disabled={syncing} onclick={sync}>
					<RefreshCw class="h-3.5 w-3.5 {syncing ? 'animate-spin' : ''}" />
					{syncing ? 'Importing…' : 'Sync now'}
				</button>
			{/if}
			<button class="btn-ghost text-xs" onclick={showClaude}>What Claude reads</button>
			{#if canWrite}
				<button class="btn-primary text-xs" onclick={() => edit(null)}>
					<Plus class="h-4 w-4" /> Add entry
				</button>
			{/if}
		</div>
	</div>
	{#if syncResult}<p class="text-xs text-ink">{syncResult}</p>{/if}

	<!-- Filters. -->
	<div class="flex flex-wrap items-center gap-2">
		<input
			class="input w-72"
			placeholder="Search title, use when, text or topic"
			bind:value={search}
		/>
		<select class="input w-auto pr-9" bind:value={typeFilter} aria-label="Type">
			<option value="">All types</option>
			{#each types as t, i (t.id)}<option value={t.id}>{i + 1} · {t.label}</option>{/each}
		</select>
		<select class="input w-auto pr-9" bind:value={audienceFilter} aria-label="Audience">
			<option value="">Any audience</option>
			{#each audiences as a (a.id)}<option value={a.id}>{a.label}</option>{/each}
		</select>
		<select class="input w-auto pr-9" bind:value={statusFilter} aria-label="Status">
			<option value="">Any status</option>
			<option value="approved">Approved</option>
			<option value="draft">Draft</option>
			<option value="review">Review due</option>
			<option value="nouse">No “Use when”</option>
		</select>
		<select class="input w-auto pr-9" bind:value={useFilter} aria-label="How Claude uses it">
			<option value="">Any use by Claude</option>
			{#each uses as u (u.id)}<option value={u.id}>{u.label}</option>{/each}
		</select>
		<label class="flex items-center gap-1.5 text-sm text-ink-soft">
			<input type="checkbox" bind:checked={showExpired} /> Show expired ({expired.length})
		</label>
	</div>

	<section class="overflow-x-auto card">
		{#if loading}
			<p class="px-4 py-4 text-sm text-ink-soft">Loading…</p>
		{:else if !entries.length}
			<div class="px-4 py-2">
				<Empty title="No knowledge yet">
					Add what Claude should know (the Fellowship, the Pledge, the pitch for funds and
					universities, current offers), or put documents in the Knowledge folder and press Sync
					now.
				</Empty>
			</div>
		{:else}
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-line/60 text-left text-xs font-semibold text-ink-soft">
						<th class="px-4 py-2">Document</th>
						<th class="px-3 py-2">
							<button
								class="font-semibold {sortBy === 'rank' ? 'text-ink' : ''}"
								title="Precedence: when two entries disagree, the lower number wins"
								onclick={() => (sortBy = 'rank')}
							>
								Type{sortBy === 'rank' ? ' ↑' : ''}
							</button>
						</th>
						<th class="px-3 py-2">Audience</th>
						<th class="px-3 py-2">Claude</th>
						<th class="px-3 py-2">Last approval</th>
						<th class="px-3 py-2">
							<button
								class="font-semibold {sortBy === 'updated' ? 'text-ink' : ''}"
								onclick={() => (sortBy = 'updated')}
							>
								Last updated{sortBy === 'updated' ? ' ↓' : ''}
							</button>
						</th>
						<th class="px-3 py-2"><span class="sr-only">Actions</span></th>
					</tr>
				</thead>
				<tbody class="divide-y divide-line/40">
					{#each rows as e (e.id)}
						<tr class="align-top {isExpired(e) || useOf(e) === 'off' ? 'opacity-60' : ''}">
							<td class="max-w-xl px-4 py-3">
								<button
									type="button"
									class="text-left font-semibold hover:text-primary-700"
									title="Open the full text"
									onclick={() => open(e)}
								>
									{e.label || firstLine(e)}
								</button>
								{#if e.useWhen}
									<div class="mt-0.5 text-ink">{e.useWhen}</div>
								{:else if canWrite}
									<button
										class="mt-0.5 block text-left text-xs text-amber-700 hover:underline"
										onclick={() => edit(e)}
									>
										Add “Use when…”: Claude can't tell when to read it
									</button>
								{/if}
								<div
									class="mt-1 flex flex-wrap items-center gap-x-2 font-mono text-xs text-ink-soft"
								>
									{#if e.source === 'drive'}
										{#if e.url}<a
												href={e.url}
												target="_blank"
												rel="noopener noreferrer"
												class="inline-flex items-center gap-1 hover:text-primary-700"
											>
												Drive{#if e.topics?.length}/{e.topics[0]}{/if}
												<ExternalLink class="h-3 w-3" />
											</a>{:else}Drive{/if}
										{#if e.truncated}· cut at 50,000 characters{/if}
									{:else}
										Hub
									{/if}
									{#each (e.topics ?? []).slice(e.source === 'drive' ? 1 : 0) as t (t)}
										<span>#{t}</span>
									{/each}
									{#if e.expiredAt}
										<span class={isExpired(e) ? 'text-danger' : 'text-amber-700'}>
											{isExpired(e) ? 'expired' : 'until'}
											{day(e.expiredAt)}
										</span>
									{/if}
								</div>
							</td>
							<td class="px-3 py-3 whitespace-nowrap">
								{typeIndex(e) + 1} · {types[typeIndex(e)]?.label ?? 'Other'}
							</td>
							<td class="px-3 py-3">
								<span
									class="rounded px-1.5 py-0.5 text-xs font-semibold {e.audience === 'restricted'
										? 'bg-danger/10 text-danger'
										: e.audience === 'external'
											? 'bg-primary-50 text-primary-700'
											: 'bg-canvas text-ink-soft'}"
								>
									{e.audience === 'restricted' ? 'admins only' : (e.audience ?? 'internal')}
								</span>
							</td>
							<td class="px-3 py-3">
								{#if canWrite && uses.length}
									<select
										class="rounded-md border border-line bg-white py-1 pr-8 pl-2 text-xs font-semibold focus:ring-focus {USE_TONE[
											useOf(e)
										]}"
										title="How Claude uses it"
										disabled={savingUse === e.id}
										value={useOf(e)}
										onchange={(ev) => setUse(e, ev.currentTarget.value)}
									>
										{#each uses as u (u.id)}<option
												value={u.id}
												disabled={u.id === 'always' && !approved(e)}
											>
												{u.label}
											</option>{/each}
									</select>
								{:else}
									<span class="text-xs font-semibold {USE_TONE[useOf(e)]}">
										{uses.find((u) => u.id === useOf(e))?.label ?? useOf(e)}
									</span>
								{/if}
							</td>
							<td class="px-3 py-3 whitespace-nowrap">
								{#if approved(e)}
									<div class="text-success">{e.approvedOn ? day(e.approvedOn) : 'Approved'}</div>
									<div class="text-xs text-ink-soft">{e.approvedBy}</div>
									{#if reviewDue(e)}
										<div class="text-xs font-semibold text-amber-700">Review due</div>
										{#if canWrite}<button
												class="text-xs font-semibold text-primary-700 hover:underline"
												disabled={approving === e.id}
												onclick={() => setCard(e, { reviewed: true })}
											>
												Mark reviewed
											</button>{/if}
									{/if}
								{:else}
									<div class="text-ink-soft">Not approved yet</div>
									{#if canWrite}<button
											class="text-xs font-semibold text-success hover:underline"
											disabled={approving === e.id}
											onclick={() => setCard(e, { status: 'approved' })}
										>
											Approve
										</button>{/if}
								{/if}
							</td>
							<td class="px-3 py-3 whitespace-nowrap">
								<div>{formatDate(e.updatedAt)}</div>
								<div class="max-w-36 truncate text-xs text-ink-soft">{e.updatedBy}</div>
							</td>
							<td class="px-3 py-3 whitespace-nowrap">
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
							</td>
						</tr>
					{:else}
						<tr><td colspan="7" class="px-4 py-4 text-sm text-ink-soft">No entry matches.</td></tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>
	<p class="text-xs text-ink-soft">
		Type order is the precedence: when two entries disagree, the lower number wins, then approved
		over draft, then the more recently reviewed. Only an approved entry can be Always. Admins-only
		entries are hidden from everyone else and from their Claude.
	</p>
</div>

<KnowledgeModal bind:open={editOpen} entry={editing} {uses} {types} {audiences} {reviewEvery} />

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
						{r.label}{#if r.useWhen}<span class="text-xs text-ink">
								· {r.useWhen}
							</span>{/if}{#if r.topics.length}<span class="text-xs text-ink-soft">
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
