<script lang="ts">
	import { collection, query, where, orderBy, limit } from 'firebase/firestore';
	import Plus from '@lucide/svelte/icons/plus';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash from '@lucide/svelte/icons/trash-2';
	import Save from '@lucide/svelte/icons/save';
	import { db } from '$lib/firebase';
	import { callAction, errorText } from '$lib/actions';
	import { hasPermission, listen, setTitle, relative } from '$lib/utils';
	import { contactSubtitle, contactTitle, crmConfig } from '$lib/helpers/crmConfig.svelte';
	import type { Contact, Strategy } from '$lib/types/crm';
	import Modal from '$lib/components/shared/Modal.svelte';
	import FormError from '$lib/components/shared/FormError.svelte';
	import Empty from '$lib/components/shared/Empty.svelte';
	import NewContactDialog from '$lib/components/crm/NewContactDialog.svelte';
	import Building from '@lucide/svelte/icons/building-2';

	setTitle('Go-to-market', 'Strategies and the organisations we reach out to');

	const cfg = crmConfig();
	const canWrite = hasPermission('crm.any.write');
	let strategies = $state<Strategy[]>([]);
	let partners = $state<Contact[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let showDone = $state(false);

	$effect(() => {
		const unsubs = [
			listen<Strategy>(
				query(collection(db, 'strategy'), orderBy('createdAt'), limit(200)),
				(rows) => (strategies = rows),
				() => (error = "Couldn't load the strategies. Reload the page to try again.")
			),
			listen<Contact>(
				query(collection(db, 'contact'), where('type', '==', 'partner'), limit(500)),
				(rows) => {
					partners = rows;
					loading = false;
				},
				() => {
					error = "Couldn't load the organisations. Reload the page to try again.";
					loading = false;
				}
			)
		];
		return () => unsubs.forEach((u) => u());
	});

	let stages = $derived(cfg.value?.pipelines.partner?.stages ?? []);
	const segmentLabel = (id: string) => cfg.value?.segments.find((s) => s.id === id)?.label ?? id;
	const nextStepLabel = (id?: string) => cfg.value?.nextSteps.find((s) => s.id === id)?.label ?? '';
	const stageLabel = (id: string) => stages.find((s) => s.id === id)?.label ?? id;

	// Strategies in order (active, paused, done), each with its Partners; then the unlinked ones.
	const ORDER = { active: 0, paused: 1, done: 2 };
	let groups = $derived.by(() => {
		const known = new Set(strategies.map((s) => s.id));
		const byStage = (a: Contact, b: Contact) =>
			stages.findIndex((s) => s.id === a.stage) - stages.findIndex((s) => s.id === b.stage);
		const out = [...strategies]
			.filter((s) => showDone || s.status !== 'done')
			.sort((a, b) => ORDER[a.status] - ORDER[b.status])
			.map((s) => ({
				strategy: s as Strategy | null,
				rows: partners.filter((p) => p.strategyId === s.id).sort(byStage)
			}));
		const loose = partners.filter((p) => !p.strategyId || !known.has(p.strategyId));
		if (loose.length) out.push({ strategy: null, rows: loose.sort(byStage) });
		return out;
	});
	let doneCount = $derived(strategies.filter((s) => s.status === 'done').length);

	// Add / edit a strategy.
	let editOpen = $state(false);
	let editId = $state<string | null>(null);
	let draft = $state({ name: '', segment: '', status: 'active', description: '' });
	let pristine = $state('');
	let saving = $state(false);
	let formError = $state<string | null>(null);
	function edit(s: Strategy | null) {
		editId = s?.id ?? null;
		draft = {
			name: s?.name ?? '',
			segment: s?.segment ?? '',
			status: s?.status ?? 'active',
			description: s?.description ?? ''
		};
		pristine = JSON.stringify(draft);
		formError = null;
		editOpen = true;
	}

	// "Add organisation": a new Partner, already in this strategy.
	let adding = $state(false);
	let addTo = $state('');
	function addOrganisation(s: Strategy | null) {
		addTo = s?.id ?? '';
		adding = true;
	}
	async function save() {
		if (!draft.name.trim()) return;
		saving = true;
		formError = null;
		try {
			await callAction('crm:strategy.save', { id: editId, ...draft });
			editOpen = false;
		} catch (e) {
			formError = errorText(e);
		} finally {
			saving = false;
		}
	}
	async function remove(s: Strategy) {
		if (!confirm(`Delete the strategy "${s.name}"? Its organisations stay, without a strategy.`))
			return;
		error = null;
		try {
			await callAction('crm:strategy.delete', { id: s.id });
		} catch (e) {
			error = errorText(e);
		}
	}
</script>

<div class="mx-auto max-w-6xl space-y-4">
	<div class="flex items-center justify-between gap-4">
		<p class="min-w-0 flex-1 text-sm text-ink-soft">
			Organisations are Partners in the <a href="/crm?type=partner" class="text-primary-700">
				CRM
			</a>. Add one to a strategy with its Add organisation button; discussion notes go on its
			timeline.
		</p>
		<div class="flex shrink-0 items-center gap-2">
			{#if doneCount}
				<label class="flex items-center gap-1.5 text-xs text-ink-soft">
					<input type="checkbox" class="rounded text-primary-600" bind:checked={showDone} />
					Show {doneCount} done
				</label>
			{/if}
			{#if canWrite}
				<button class="btn-primary" onclick={() => edit(null)}>
					<Plus class="h-4 w-4" /> New strategy
				</button>
			{/if}
		</div>
	</div>
	<FormError message={error} />

	{#if loading || !cfg.value}
		<p class="text-sm text-ink-soft">Loading…</p>
	{:else if groups.length === 0 && doneCount}
		<Empty title="Every strategy is done">
			Tick “Show {doneCount} done” to see them, or start a new strategy.
		</Empty>
	{:else if groups.length === 0}
		<Empty title="No strategies yet">
			A strategy is a plan for one kind of organisation, e.g. “European VC funds sponsor a Fellow”
			or “Business schools offer the Fellowship to alumni”. Create one, then link Partners to it.
		</Empty>
	{/if}

	{#each groups as g (g.strategy?.id ?? 'unlinked')}
		{@const s = g.strategy}
		<section class="card">
			<div class="flex items-start justify-between gap-4 border-b border-line/60 px-4 py-3">
				<div class="min-w-0">
					<div class="flex flex-wrap items-center gap-2">
						<h2 class="font-bold">{s ? s.name : 'Not linked to a strategy'}</h2>
						{#if s?.segment}<span
								class="rounded bg-primary-50 px-1.5 py-0.5 text-xs font-semibold text-primary-700"
							>
								{segmentLabel(s.segment)}
							</span>{/if}
						{#if s}<span
								class="rounded px-1.5 py-0.5 text-xs font-semibold capitalize {s.status === 'active'
									? 'bg-primary-600 text-white'
									: 'bg-canvas text-ink-soft'}"
							>
								{s.status}
							</span>{/if}
					</div>
					{#if s?.description}
						<p class="mt-1 text-sm whitespace-pre-line text-ink-soft">{s.description}</p>
					{/if}
				</div>
				{#if canWrite}
					<div class="flex shrink-0 items-center gap-1">
						<button class="btn-ghost whitespace-nowrap" onclick={() => addOrganisation(s)}>
							<Building class="h-4 w-4" /> Add organisation
						</button>
						{#if s}
							<button class="btn-ghost px-2" aria-label="Edit" onclick={() => edit(s)}>
								<Pencil class="h-4 w-4" />
							</button>
							<button
								class="btn-ghost px-2 text-danger"
								aria-label="Delete"
								onclick={() => remove(s)}
							>
								<Trash class="h-4 w-4" />
							</button>
						{/if}
					</div>
				{/if}
			</div>

			<!-- The funnel: organisations per stage. -->
			<div class="grid grid-cols-6 gap-px border-b border-line/60 bg-line/40">
				{#each stages as st (st.id)}
					<div class="bg-white px-3 py-2">
						<div class="text-[11px] font-semibold text-ink-soft">{st.label}</div>
						<div class="text-lg font-bold">
							{g.rows.filter((p) => p.stage === st.id).length}
						</div>
					</div>
				{/each}
			</div>

			{#if g.rows.length}
				<table class="w-full text-sm">
					<thead class="text-left text-xs text-ink-soft">
						<tr>
							<th class="px-4 py-2 font-semibold">Organisation</th>
							<th class="px-4 py-2 font-semibold">Stage</th>
							<th class="px-4 py-2 font-semibold">Main contact</th>
							<th class="px-4 py-2 font-semibold">Next step</th>
							<th class="px-4 py-2 font-semibold">Owner</th>
							<th class="px-4 py-2 text-right font-semibold">Last activity</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-line/40">
						{#each g.rows as p (p.id)}
							<tr class="hover:bg-canvas">
								<td class="px-4 py-2">
									<a href="/crm/{p.id}" class="font-semibold hover:text-primary-700">
										{contactTitle(p)}
									</a>
									{#if p.segment && !s?.segment}<div class="text-xs text-ink-soft">
											{segmentLabel(p.segment)}
										</div>{/if}
								</td>
								<td class="px-4 py-2">{stageLabel(p.stage)}</td>
								<td class="px-4 py-2">
									{contactSubtitle(p) || '—'}
									{#if p.email}<a
											href="mailto:{p.email}"
											class="block text-xs text-ink-soft hover:text-primary-700"
										>
											{p.email}
										</a>{/if}
								</td>
								<td class="px-4 py-2 text-ink-soft">{nextStepLabel(p.nextStep) || '—'}</td>
								<td class="px-4 py-2 text-ink-soft">{p.ownerName ?? '—'}</td>
								<td class="px-4 py-2 text-right text-xs text-ink-soft">
									{relative(p.lastActivityAt)}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{:else}
				<p class="px-4 py-3 text-sm text-ink-soft">No organisations yet.</p>
			{/if}
		</section>
	{/each}
</div>

<Modal
	bind:open={editOpen}
	title={editId ? 'Edit strategy' : 'New strategy'}
	width="max-w-2xl"
	dirty={JSON.stringify(draft) !== pristine}
>
	<div class="grid grid-cols-2 gap-3">
		<div class="col-span-2">
			<label class="label" for="s-name">Name</label>
			<input
				id="s-name"
				class="input"
				maxlength="120"
				bind:value={draft.name}
				placeholder="e.g. European VC funds sponsor a Fellow"
			/>
		</div>
		<div>
			<label class="label" for="s-segment">Segment</label>
			<select id="s-segment" class="input" bind:value={draft.segment}>
				<option value="">Any</option>
				{#each cfg.value?.segments ?? [] as x (x.id)}<option value={x.id}>{x.label}</option>{/each}
			</select>
		</div>
		<div>
			<label class="label" for="s-status">Status</label>
			<select id="s-status" class="input capitalize" bind:value={draft.status}>
				{#each cfg.value?.strategyStatuses ?? [] as x (x)}<option value={x}>{x}</option>{/each}
			</select>
		</div>
		<div class="col-span-2">
			<label class="label" for="s-description">Approach</label>
			<textarea
				id="s-description"
				class="input"
				rows="7"
				maxlength="5000"
				bind:value={draft.description}
				placeholder="Who we target, the pitch, the offer, how we reach them, what success looks like."
			></textarea>
		</div>
	</div>
	<FormError message={formError} />
	{#snippet footer()}
		<button class="btn-ghost" onclick={() => (editOpen = false)}>Cancel</button>
		<button class="btn-primary" disabled={saving || !draft.name.trim()} onclick={save}>
			<Save class="h-4 w-4" />
			{saving ? 'Saving…' : 'Save'}
		</button>
	{/snippet}
</Modal>

{#if canWrite && cfg.value}
	<NewContactDialog bind:open={adding} config={cfg.value} type="partner" strategyId={addTo} />
{/if}
