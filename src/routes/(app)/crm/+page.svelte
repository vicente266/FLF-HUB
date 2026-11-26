<script lang="ts">
	import {
		collection,
		query,
		where,
		orderBy,
		limit,
		getCountFromServer,
		Timestamp,
		type QueryConstraint
	} from 'firebase/firestore';
	import { untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { page } from '$app/state';
	import { afterNavigate, goto } from '$app/navigation';
	import Plus from '@lucide/svelte/icons/plus';
	import Search from '@lucide/svelte/icons/search';
	import Columns3 from '@lucide/svelte/icons/columns-3';
	import List from '@lucide/svelte/icons/list';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import FellowProfile from '$lib/components/crm/FellowProfile.svelte';
	import NewContactDialog from '$lib/components/crm/NewContactDialog.svelte';
	import ReasonDialog from '$lib/components/crm/ReasonDialog.svelte';
	import MoveNotice from '$lib/components/crm/MoveNotice.svelte';
	import BulkAssign from '$lib/components/crm/BulkAssign.svelte';
	import { db } from '$lib/firebase';
	import { me } from '$lib/stores';
	import { hasPermission, listen, setTitle, relative, formatDate, toDate } from '$lib/utils';
	import {
		attentionDays,
		contactSubtitle,
		contactTitle,
		crmBack,
		crmConfig,
		daysQuiet,
		initials,
		moveContact,
		sourceLabel,
		stageLabel,
		typeStyle
	} from '$lib/helpers/crmConfig.svelte';
	import type { Contact, ContactType } from '$lib/types/crm';
	import FormError from '$lib/components/shared/FormError.svelte';
	import Empty from '$lib/components/shared/Empty.svelte';

	setTitle('CRM', 'Fellows, Gurus, Investors and Partners');

	const cfg = crmConfig();
	const canWrite = hasPermission('crm.any.write');

	// Tab, view and filters live in the URL (?type=investor&view=list&attention=1&owner=me&since=30
	// &lost=1), so a link or the contact page's back link opens the same list. A phone opens in list
	// view. "all" is every type, as a list (Home's cards link there). owner=none: no owner.
	const DAY = 86_400_000;
	let type = $state<ContactType | 'all'>('');
	let view = $state<'board' | 'list'>('board');
	let search = $state('');
	let owner = $state<'' | 'me' | 'none'>('');
	let attentionOnly = $state(false);
	/** Lost and Declined (losing final stages) are hidden unless this is on. */
	let showLost = $state(false);
	/** Only contacts created in the last N days (0 = any). */
	let since = $state(0);
	function readUrl(url: URL) {
		const p = url.searchParams;
		type = p.get('type') ?? '';
		view =
			p.get('view') === 'list' ||
			(!p.get('view') && typeof window !== 'undefined' && window.innerWidth < 768)
				? 'list'
				: 'board';
		search = p.get('q') ?? '';
		const o = p.get('owner');
		owner = o === 'me' || o === 'none' ? o : '';
		attentionOnly = p.get('attention') === '1';
		showLost = p.get('lost') === '1';
		since = Math.max(0, Number(p.get('since')) || 0);
	}
	readUrl(page.url);
	// The URL this page last wrote; any other (the sidebar's CRM link, a link from Home) is read
	// again, so the screen always shows what the URL says.
	let written = '';
	afterNavigate(({ to }) => {
		if (to?.url.pathname === '/crm' && `${to.url.pathname}${to.url.search}` !== written)
			readUrl(to.url);
	});

	// The first contact type the backend defines, once its config arrives (or an unknown one in
	// the URL).
	$effect(() => {
		if (cfg.value && type !== 'all' && !cfg.value.types.includes(type)) type = cfg.value.types[0];
	});

	let all = $derived(type === 'all');
	$effect(() => {
		if (!type) return;
		const q: [string, string][] = [
			['type', type],
			['view', all ? 'list' : view]
		];
		if (attentionOnly) q.push(['attention', '1']);
		if (owner) q.push(['owner', owner]);
		if (since) q.push(['since', String(since)]);
		if (showLost) q.push(['lost', '1']);
		if (search.trim()) q.push(['q', search.trim()]);
		const href = `/crm?${q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
		crmBack.href = href;
		untrack(() => {
			if (page.url.pathname === '/crm' && `${page.url.pathname}${page.url.search}` !== href) {
				written = href;
				goto(href, { replaceState: true, keepFocus: true, noScroll: true });
			}
		});
	});

	let contacts = $state<Contact[]>([]);
	let loaded = $state(false);

	let staleDays = $derived(cfg.value?.staleDays ?? 14);
	// One bounded listener. A type tab: its 500 newest, filtered below. All: the filters go into
	// the query, so "needs attention" and "new" are complete across every type, as Home counts them.
	$effect(() => {
		const t = type;
		if (!t) return;
		const uid = $me?.uid;
		const filters: QueryConstraint[] = [];
		if (t !== 'all') filters.push(where('type', '==', t), orderBy('createdAt', 'desc'));
		else {
			if (owner === 'me' && uid) filters.push(where('ownerUid', '==', uid));
			if (owner === 'none') filters.push(where('ownerUid', '==', null));
			if (attentionOnly) {
				// Since is applied below: one range per query here.
				const cutoff = Timestamp.fromMillis(Date.now() - staleDays * DAY);
				filters.push(
					where('open', '==', true),
					where('lastActivityAt', '<', cutoff),
					orderBy('lastActivityAt')
				);
			} else {
				if (since)
					filters.push(where('createdAt', '>=', Timestamp.fromMillis(Date.now() - since * DAY)));
				filters.push(orderBy('createdAt', 'desc'));
			}
		}
		loaded = false;
		return listen<Contact>(query(collection(db, 'contact'), ...filters, limit(500)), (rows) => {
			contacts = rows;
			loaded = true;
		});
	});

	const attention = (c: Contact) => attentionDays(c, staleDays);
	const isNew = (c: Contact) => (toDate(c.createdAt)?.getTime() ?? 0) >= Date.now() - since * DAY;
	let filtering = $derived(!!owner || attentionOnly || !!since || !!search.trim());
	/** In a losing final stage (Lost, Declined). */
	const losing = (c: Contact) =>
		!!cfg.value?.pipelines[c.type]?.stages.find((s) => s.id === c.stage)?.askReason;
	let matching = $derived(
		contacts.filter((c) => {
			if (owner === 'me' && c.ownerUid !== $me?.uid) return false;
			if (owner === 'none' && c.ownerUid) return false;
			if (attentionOnly && attention(c) === null) return false;
			if (since && !isNew(c)) return false;
			const q = search.trim().toLowerCase();
			if (!q) return true;
			return [c.name, c.email, c.company, ...(c.tags ?? [])].some((v) =>
				v?.toLowerCase().includes(q)
			);
		})
	);
	let lostCount = $derived(matching.filter(losing).length);
	let filtered = $derived(showLost ? matching : matching.filter((c) => !losing(c)));

	// Contacts per type, so an empty pipeline's tab shows muted with 0: one count per type, once.
	// The open tab follows its live list instead (its first contact un-mutes it at once).
	let typeCounts = $state<Record<string, number>>({});
	$effect(() => {
		const types = cfg.value?.types;
		if (!types) return;
		untrack(() => {
			for (const t of types)
				getCountFromServer(query(collection(db, 'contact'), where('type', '==', t)))
					.then((r) => (typeCounts[t] = r.data().count))
					.catch(() => {});
		});
	});
	const countOf = (t: ContactType) =>
		t === type && loaded && contacts.length < 500 ? contacts.length : typeCounts[t];

	// Bulk owner assignment from the list: ticked rows that are still shown.
	const selected = new SvelteSet<string>();
	let chosen = $derived(filtered.filter((c) => selected.has(c.id)).map((c) => c.id));
	let allChosen = $derived(filtered.length > 0 && chosen.length === filtered.length);
	function toggleAll(on: boolean) {
		for (const c of filtered) {
			if (on) selected.add(c.id);
			else selected.delete(c.id);
		}
	}
	// Another tab starts with nothing selected.
	$effect(() => {
		void type;
		untrack(() => selected.clear());
	});

	let stages = $derived(all ? [] : (cfg.value?.pipelines[type]?.stages ?? []));
	// Losing columns show only with "Show lost".
	let columns = $derived(stages.filter((s) => showLost || !s.askReason));

	// Losing columns (Lost, Declined) start folded, so the working stages fit the screen.
	let expanded = $state<Record<string, boolean>>({});
	const folded = (s: { id: string; askReason?: boolean }) =>
		!!s.askReason && !expanded[`${type}:${s.id}`];

	/** Card date colour for an open contact: warning after 30 days without activity, danger after 90. */
	function ageTone(c: Contact) {
		const d = daysQuiet(c);
		if (!c.open || d === null) return 'text-ink-soft';
		if (d >= 90) return 'text-danger font-semibold';
		if (d >= 30) return 'text-warning font-semibold';
		return 'text-ink-soft';
	}

	// Drag a card to another column to move it.
	let dragging = $state<string | null>(null);
	let moveError = $state<string | null>(null);
	async function drop(stage: string) {
		const id = dragging;
		dragging = null;
		const c = contacts.find((x) => x.id === id);
		const to = stages.find((s) => s.id === stage);
		if (!id || !c || !to || c.stage === stage || !canWrite) return;
		moveError = null;
		// Optimistic; the listener confirms. On failure nothing changed in Firestore, so the
		// listener won't put it back: the rollback does.
		moveError = await moveContact(c, to, () => {
			const previous = c.stage;
			c.stage = stage;
			return () => (c.stage = previous);
		});
	}

	let creating = $state(false);
	// The Fellow whose profile pop-up is open (null = closed).
	let profileOf = $state<Contact | null>(null);
	let profileOpen = $state(false);
	function openProfile(c: Contact) {
		profileOf = c;
		profileOpen = true;
	}
</script>

{#if cfg.value}
	{@const config = cfg.value}
	{@const pipeline = config.pipelines[type]}
	<div class="space-y-4">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<div class="flex flex-wrap rounded-lg border border-line/70 bg-white p-0.5">
				{#each config.types as t (t)}
					{@const n = countOf(t)}
					{@const empty = n === 0}
					<button
						class="flex items-center gap-1 rounded-md px-3 py-1 text-sm font-semibold {type === t
							? 'bg-primary-600 text-white'
							: empty
								? 'text-ink-soft/50 hover:text-ink-soft'
								: 'text-ink-soft hover:text-ink'}"
						title={empty ? `No ${config.pipelines[t].plural.toLowerCase()} yet` : undefined}
						onclick={() => (type = t)}
					>
						{config.pipelines[t].plural}
						{#if empty}<span class="text-[11px] font-normal">0</span>{/if}
					</button>
				{/each}
				<button
					class="rounded-md px-3 py-1 text-sm font-semibold {all
						? 'bg-primary-600 text-white'
						: 'text-ink-soft hover:text-ink'}"
					title="Every type, as a list"
					onclick={() => (type = 'all')}
				>
					All
				</button>
			</div>

			<div class="flex min-w-0 grow flex-wrap items-center justify-start gap-2 md:justify-end">
				<div class="relative max-w-60 min-w-32 flex-1">
					<Search class="pointer-events-none absolute top-2 left-2.5 h-4 w-4 text-ink-soft/60" />
					<input
						class="input w-full pl-8"
						placeholder="Search"
						aria-label="Search name, email, company or tag"
						bind:value={search}
					/>
				</div>
				<select class="input w-auto py-1 pr-8" aria-label="Owner" bind:value={owner}>
					<option value="">Any owner</option>
					<option value="me">Mine</option>
					<option value="none">No owner</option>
				</select>
				<label
					class="flex items-center gap-1.5 text-sm whitespace-nowrap"
					title="Open, with no activity for {staleDays} days"
				>
					<input type="checkbox" class="rounded text-primary-600" bind:checked={attentionOnly} /> Needs
					attention
				</label>
				<label class="flex items-center gap-1.5 text-sm whitespace-nowrap" title="Created recently">
					<input
						type="checkbox"
						class="rounded text-primary-600"
						checked={!!since}
						onchange={(e) => (since = e.currentTarget.checked ? 30 : 0)}
					/>
					New ({since || 30} days)
				</label>
				{#if lostCount || showLost}
					<label
						class="flex items-center gap-1.5 text-sm whitespace-nowrap"
						title="Lost and Declined contacts"
					>
						<input type="checkbox" class="rounded text-primary-600" bind:checked={showLost} />
						Show lost ({lostCount})
					</label>
				{/if}
				<div class="flex rounded-lg border border-line/70 bg-white p-0.5">
					<button
						class="rounded-md p-1.5 disabled:opacity-40 {view === 'board' && !all
							? 'bg-primary-50 text-primary-700'
							: 'text-ink-soft'}"
						title={all ? 'Board: pick a type first' : 'Board'}
						aria-label="Board"
						disabled={all}
						onclick={() => (view = 'board')}
					>
						<Columns3 class="h-4 w-4" />
					</button>
					<button
						class="rounded-md p-1.5 {view === 'list' || all
							? 'bg-primary-50 text-primary-700'
							: 'text-ink-soft'}"
						title="List"
						aria-label="List"
						onclick={() => (view = 'list')}
					>
						<List class="h-4 w-4" />
					</button>
				</div>
				{#if canWrite}
					<button class="btn-primary whitespace-nowrap" onclick={() => (creating = true)}>
						<Plus class="h-4 w-4" /> New contact
					</button>
				{/if}
			</div>
		</div>

		<FormError message={moveError} />
		<MoveNotice onerror={(m) => (moveError = m)} />
		{#if canWrite && (view === 'list' || all)}
			<BulkAssign ids={chosen} onclear={() => selected.clear()} onerror={(m) => (moveError = m)} />
		{/if}

		{#if loaded && contacts.length === 0 && !filtering && pipeline}
			<Empty title="Add your first {pipeline.label.toLowerCase()}">
				<p>{pipeline.description}</p>
				{#if canWrite}
					<button class="mt-3 btn-primary" onclick={() => (creating = true)}>
						<Plus class="h-4 w-4" /> New contact
					</button>
				{/if}
			</Empty>
		{:else if view === 'board' && !all}
			{#if loaded && filtering && filtered.length === 0}
				<p class="text-sm text-ink-soft">No contacts match these filters.</p>
			{/if}
			<!-- Only the board scrolls sideways, inside itself. -->
			<div class="flex gap-2 overflow-x-auto pb-4">
				{#each columns as stage (stage.id)}
					{@const cards = filtered.filter((c) => c.stage === stage.id)}
					{#if folded(stage)}
						<button
							class="flex w-10 shrink-0 flex-col items-center gap-2 rounded-xl bg-primary-50/60 py-2 text-ink-soft hover:bg-primary-50"
							title="Show {stage.label}"
							ondragover={(e) => e.preventDefault()}
							ondrop={() => drop(stage.id)}
							onclick={() => (expanded[`${type}:${stage.id}`] = true)}
						>
							<ChevronRight class="h-4 w-4" />
							<span class="rounded-full bg-white px-1.5 text-[11px] font-semibold">
								{cards.length}
							</span>
							<span class="text-xs font-bold tracking-wide uppercase [writing-mode:vertical-rl]">
								{stage.label}
							</span>
						</button>
					{:else}
						<div
							class="flex w-48 shrink-0 flex-col rounded-xl bg-primary-50/60 lg:w-auto lg:min-w-40 lg:flex-1 {stage.final
								? 'opacity-80'
								: ''}"
							role="list"
							ondragover={(e) => e.preventDefault()}
							ondrop={() => drop(stage.id)}
						>
							<div class="flex items-start justify-between gap-2 px-3 py-2">
								<span class="text-xs leading-tight font-bold tracking-wide text-ink-soft uppercase">
									{stage.label}
								</span>
								<span class="flex shrink-0 items-center gap-1">
									<span
										class="rounded-full bg-white px-1.5 text-[11px] font-semibold text-ink-soft"
									>
										{cards.length}
									</span>
									{#if stage.askReason}
										<button
											class="text-[11px] text-ink-soft hover:text-ink"
											title="Fold {stage.label}"
											onclick={() => (expanded[`${type}:${stage.id}`] = false)}
										>
											Hide
										</button>
									{/if}
								</span>
							</div>
							<div class="flex min-h-24 flex-col gap-2 px-2 pb-2">
								{#each cards as c (c.id)}
									{@const quiet = attention(c)}
									<a
										href="/crm/{c.id}"
										draggable={canWrite}
										ondragstart={() => (dragging = c.id)}
										class="block card px-3 py-2 hover:border-primary-300"
									>
										<div class="flex items-start justify-between gap-2">
											<span class="min-w-0 text-sm font-semibold break-words">
												{contactTitle(c)}
											</span>
											{#if quiet !== null}<span title="{quiet} days without activity">
													<TriangleAlert class="h-3.5 w-3.5 shrink-0 text-warning" />
												</span>{/if}
										</div>
										{#if contactSubtitle(c)}<div class="truncate text-xs text-ink-soft">
												{contactSubtitle(c)}
											</div>{/if}
										<div class="mt-2 flex items-center justify-between gap-3 text-[11px]">
											{#if c.ownerName}
												<span
													class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary-100 text-[10px] font-bold text-primary-700"
													title={c.ownerName}
												>
													{initials(c.ownerName)}
												</span>
											{:else}
												<span class="text-ink-soft">No owner</span>
											{/if}
											<span
												class="shrink-0 {ageTone(c)}"
												title="Last activity {formatDate(c.lastActivityAt)}"
											>
												{relative(c.lastActivityAt)}
											</span>
										</div>
									</a>
								{/each}
							</div>
						</div>
					{/if}
				{/each}
			</div>
		{:else}
			<div class="overflow-hidden card">
				<table class="w-full text-sm">
					<thead class="bg-canvas text-left text-xs text-ink-soft">
						<tr>
							{#if canWrite}
								<th class="w-8 py-2 pl-4">
									<input
										type="checkbox"
										class="rounded text-primary-600"
										aria-label="Select all shown"
										checked={allChosen}
										indeterminate={chosen.length > 0 && !allChosen}
										onchange={(e) => toggleAll(e.currentTarget.checked)}
									/>
								</th>
							{/if}
							<th class="px-4 py-2 font-semibold">
								{type === 'partner' ? 'Organisation' : 'Name'}
							</th>
							{#if all}<th class="px-4 py-2 font-semibold">Type</th>{/if}
							<th class="hidden px-4 py-2 font-semibold md:table-cell">
								{#if type === 'partner'}Main contact{:else if all}Company / contact{:else}Company{/if}
							</th>
							<th class="px-4 py-2 font-semibold">Stage</th>
							<th class="hidden px-4 py-2 font-semibold md:table-cell">Owner</th>
							<th class="hidden px-4 py-2 font-semibold lg:table-cell">Source</th>
							<th class="hidden px-4 py-2 font-semibold md:table-cell">Last activity</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-line/40">
						{#each filtered as c (c.id)}
							{@const quiet = attention(c)}
							<tr class="hover:bg-canvas {selected.has(c.id) ? 'bg-primary-50/60' : ''}">
								{#if canWrite}
									<td class="w-8 py-2 pl-4">
										<input
											type="checkbox"
											class="rounded text-primary-600"
											aria-label="Select {contactTitle(c)}"
											checked={selected.has(c.id)}
											onchange={(e) =>
												e.currentTarget.checked ? selected.add(c.id) : selected.delete(c.id)}
										/>
									</td>
								{/if}
								<td class="px-4 py-2">
									<a href="/crm/{c.id}" class="font-semibold break-words hover:text-primary-700">
										{contactTitle(c)}
									</a>
									<!-- Below md the Last activity column is hidden: the marker sits by the name. -->
									{#if quiet !== null}<span class="md:hidden" title="{quiet} days without activity">
											<TriangleAlert class="ml-1 inline h-3.5 w-3.5 text-warning" />
										</span>{/if}
									<div class="text-xs break-all text-ink-soft">
										{c.email}
										{#if c.type === 'fellow'}<button
												class="ml-1 text-primary-700 hover:underline"
												onclick={() => openProfile(c)}
											>
												Profile
											</button>{/if}
									</div>
								</td>
								{#if all}<td class="px-4 py-2">
										<span
											class="rounded-md px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap {typeStyle(
												config,
												c.type
											)}"
										>
											{config.pipelines[c.type]?.label ?? c.type}
										</span>
									</td>{/if}
								<td class="hidden px-4 py-2 md:table-cell">{contactSubtitle(c) || '—'}</td>
								<td class="px-4 py-2">{stageLabel(config, c.type, c.stage)}</td>
								<td class="hidden px-4 py-2 md:table-cell">{c.ownerName ?? '—'}</td>
								<td class="hidden px-4 py-2 lg:table-cell">{sourceLabel(c.source)}</td>
								<td class="hidden px-4 py-2 whitespace-nowrap md:table-cell">
									<span class={ageTone(c)} title="Last activity {formatDate(c.lastActivityAt)}">
										{relative(c.lastActivityAt)}
									</span>
									{#if quiet !== null}<span title="{quiet} days without activity">
											<TriangleAlert class="ml-1 inline h-3.5 w-3.5 text-warning" />
										</span>{/if}
								</td>
							</tr>
						{:else}
							<tr>
								<td
									colspan={(all ? 7 : 6) + (canWrite ? 1 : 0)}
									class="px-4 py-8 text-center text-ink-soft"
								>
									{#if !loaded}Loading…{:else if filtering}No contacts match these filters.{:else if lostCount}Only
										lost contacts here: tick Show lost to see them.{:else}No contacts yet.{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>

	{#if canWrite}<NewContactDialog
			bind:open={creating}
			{config}
			type={all ? config.types[0] : type}
		/>{/if}
{:else}
	<p class="text-sm text-ink-soft">Loading…</p>
{/if}

<ReasonDialog />
{#if profileOf}<FellowProfile bind:open={profileOpen} contact={profileOf} />{/if}
