<script lang="ts">
	import { collection, query, where, orderBy, limit } from 'firebase/firestore';
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import Plus from '@lucide/svelte/icons/plus';
	import Search from '@lucide/svelte/icons/search';
	import Columns3 from '@lucide/svelte/icons/columns-3';
	import List from '@lucide/svelte/icons/list';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import FellowProfile from '$lib/components/crm/FellowProfile.svelte';
	import NewContactDialog from '$lib/components/crm/NewContactDialog.svelte';
	import ReasonDialog from '$lib/components/crm/ReasonDialog.svelte';
	import { db } from '$lib/firebase';
	import { callAction, errorText } from '$lib/actions';
	import { me } from '$lib/stores';
	import { hasPermission, listen, setTitle, relative, formatDate } from '$lib/utils';
	import {
		askReason,
		attentionDays,
		contactSubtitle,
		contactTitle,
		crmBack,
		crmConfig,
		daysQuiet,
		initials,
		sourceLabel,
		stageLabel
	} from '$lib/helpers/crmConfig.svelte';
	import type { Contact, ContactType } from '$lib/types/crm';
	import FormError from '$lib/components/shared/FormError.svelte';
	import Empty from '$lib/components/shared/Empty.svelte';

	setTitle('CRM', 'Fellows, Gurus, Investors and Partners');

	const cfg = crmConfig();
	const canWrite = hasPermission('crm.any.write');

	// Tab, view and filters live in the URL (?type=investor&view=list&attention=1&owner=me), so a
	// link or the contact page's back link opens the same list. A phone opens in list view.
	const params = page.url.searchParams;
	let type = $state<ContactType>(params.get('type') ?? '');
	let view = $state<'board' | 'list'>(
		params.get('view') === 'list' ||
			(!params.get('view') && typeof window !== 'undefined' && window.innerWidth < 768)
			? 'list'
			: 'board'
	);
	let search = $state(params.get('q') ?? '');
	let mine = $state(params.get('owner') === 'me');
	let attentionOnly = $state(params.get('attention') === '1');

	// The first contact type the backend defines, once its config arrives (or an unknown one in
	// the URL).
	$effect(() => {
		if (cfg.value && !cfg.value.types.includes(type)) type = cfg.value.types[0];
	});

	$effect(() => {
		if (!type) return;
		const q: [string, string][] = [
			['type', type],
			['view', view]
		];
		if (attentionOnly) q.push(['attention', '1']);
		if (mine) q.push(['owner', 'me']);
		if (search.trim()) q.push(['q', search.trim()]);
		const href = `/crm?${q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
		crmBack.href = href;
		untrack(() => {
			if (page.url.pathname === '/crm' && `${page.url.pathname}${page.url.search}` !== href)
				goto(href, { replaceState: true, keepFocus: true, noScroll: true });
		});
	});

	let contacts = $state<Contact[]>([]);
	let loaded = $state(false);

	// One bounded listener for the selected type.
	$effect(() => {
		const t = type;
		if (!t) return;
		loaded = false;
		return listen<Contact>(
			query(
				collection(db, 'contact'),
				where('type', '==', t),
				orderBy('createdAt', 'desc'),
				limit(500)
			),
			(rows) => {
				contacts = rows;
				loaded = true;
			}
		);
	});

	let staleDays = $derived(cfg.value?.staleDays ?? 14);
	const attention = (c: Contact) => attentionDays(c, staleDays);
	let filtering = $derived(mine || attentionOnly || !!search.trim());
	let filtered = $derived(
		contacts.filter((c) => {
			if (mine && c.ownerUid !== $me?.uid) return false;
			if (attentionOnly && attention(c) === null) return false;
			const q = search.trim().toLowerCase();
			if (!q) return true;
			return [c.name, c.email, c.company, ...(c.tags ?? [])].some((v) =>
				v?.toLowerCase().includes(q)
			);
		})
	);

	let stages = $derived(cfg.value?.pipelines[type]?.stages ?? []);

	// Losing columns (Lost, Declined) start folded, so the working stages fit the screen.
	let expanded = $state<Record<string, boolean>>({});
	const folded = (s: { id: string; askReason?: boolean }) =>
		!!s.askReason && !expanded[`${type}:${s.id}`];

	/** Card date colour: warning after 30 days without activity, danger after 90. */
	function ageTone(c: Contact) {
		const d = daysQuiet(c);
		if (d === null) return 'text-ink-soft';
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
		if (!id || !c || c.stage === stage || !canWrite) return;
		const reason = await askReason(
			stages.find((s) => s.id === stage),
			contactTitle(c)
		);
		if (reason === null) return;
		const previous = c.stage;
		c.stage = stage; // optimistic; the listener confirms
		moveError = null;
		try {
			await callAction('crm:contact.stage', { id, stage, reason });
		} catch (e) {
			// Nothing changed in Firestore, so the listener won't put it back.
			c.stage = previous;
			moveError = errorText(e);
		}
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
					<button
						class="rounded-md px-3 py-1 text-sm font-semibold {type === t
							? 'bg-primary-600 text-white'
							: 'text-ink-soft hover:text-ink'}"
						onclick={() => (type = t)}
					>
						{config.pipelines[t].plural}
					</button>
				{/each}
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
				<label class="flex items-center gap-1.5 text-sm whitespace-nowrap">
					<input type="checkbox" class="rounded text-primary-600" bind:checked={mine} /> Mine
				</label>
				<label
					class="flex items-center gap-1.5 text-sm whitespace-nowrap"
					title="Open, with no activity for {staleDays} days"
				>
					<input type="checkbox" class="rounded text-primary-600" bind:checked={attentionOnly} /> Needs
					attention
				</label>
				<div class="flex rounded-lg border border-line/70 bg-white p-0.5">
					<button
						class="rounded-md p-1.5 {view === 'board'
							? 'bg-primary-50 text-primary-700'
							: 'text-ink-soft'}"
						title="Board"
						aria-label="Board"
						onclick={() => (view = 'board')}
					>
						<Columns3 class="h-4 w-4" />
					</button>
					<button
						class="rounded-md p-1.5 {view === 'list'
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

		{#if loaded && contacts.length === 0}
			<Empty title="Add your first {pipeline.label.toLowerCase()}">
				<p>{pipeline.description}</p>
				{#if canWrite}
					<button class="mt-3 btn-primary" onclick={() => (creating = true)}>
						<Plus class="h-4 w-4" /> New contact
					</button>
				{/if}
			</Empty>
		{:else if view === 'board'}
			<!-- Only the board scrolls sideways, inside itself. -->
			<div class="flex gap-2 overflow-x-auto pb-4">
				{#each stages as stage (stage.id)}
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
							<th class="px-4 py-2 font-semibold">
								{type === 'partner' ? 'Organisation' : 'Name'}
							</th>
							<th class="hidden px-4 py-2 font-semibold md:table-cell">
								{type === 'partner' ? 'Main contact' : 'Company'}
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
							<tr class="hover:bg-canvas">
								<td class="px-4 py-2">
									<a href="/crm/{c.id}" class="font-semibold break-words hover:text-primary-700">
										{contactTitle(c)}
									</a>
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
								<td colspan="6" class="px-4 py-8 text-center text-ink-soft">
									{filtering ? 'No contacts match your search or filters.' : 'No contacts yet.'}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>

	{#if canWrite}<NewContactDialog bind:open={creating} {config} {type} />{/if}
{:else}
	<p class="text-sm text-ink-soft">Loading…</p>
{/if}

<ReasonDialog />
{#if profileOf}<FellowProfile bind:open={profileOpen} contact={profileOf} />{/if}
