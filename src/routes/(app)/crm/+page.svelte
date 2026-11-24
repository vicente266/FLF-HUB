<script lang="ts">
	import { collection, query, where, orderBy, limit } from 'firebase/firestore';
	import { goto } from '$app/navigation';
	import Plus from '@lucide/svelte/icons/plus';
	import Search from '@lucide/svelte/icons/search';
	import Columns3 from '@lucide/svelte/icons/columns-3';
	import List from '@lucide/svelte/icons/list';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { db } from '$lib/firebase';
	import { callAction, errorText } from '$lib/actions';
	import { me } from '$lib/stores';
	import { hasPermission, listen, setTitle, relative } from '$lib/utils';
	import { crmConfig, stageLabel } from '$lib/helpers/crmConfig.svelte';
	import type { Contact, ContactDraft, ContactType } from '$lib/types/crm';
	import Modal from '$lib/components/shared/Modal.svelte';
	import FormError from '$lib/components/shared/FormError.svelte';
	import ContactForm from '$lib/components/crm/ContactForm.svelte';

	setTitle('CRM', 'Fellows, Gurus and Investors');

	const cfg = crmConfig();
	const canWrite = hasPermission('crm.any.write');

	let type = $state<ContactType>('fellow');
	let view = $state<'board' | 'list'>('board');
	let search = $state('');
	let mine = $state(false);
	let attentionOnly = $state(false);
	let contacts = $state<Contact[]>([]);

	// One bounded listener for the selected type.
	$effect(() => {
		const t = type;
		return listen<Contact>(
			query(
				collection(db, 'contact'),
				where('type', '==', t),
				orderBy('createdAt', 'desc'),
				limit(500)
			),
			(rows) => (contacts = rows)
		);
	});

	let filtered = $derived(
		contacts.filter((c) => {
			if (mine && c.ownerUid !== $me?.uid) return false;
			if (attentionOnly && !c.needsAttention) return false;
			const q = search.trim().toLowerCase();
			if (!q) return true;
			return [c.name, c.email, c.company, ...(c.tags ?? [])].some((v) =>
				v?.toLowerCase().includes(q)
			);
		})
	);

	let stages = $derived(cfg.value?.pipelines[type].stages ?? []);

	// Drag a card to another column to move it.
	let dragging = $state<string | null>(null);
	let moveError = $state<string | null>(null);
	async function drop(stage: string) {
		const id = dragging;
		dragging = null;
		const c = contacts.find((x) => x.id === id);
		if (!id || !c || c.stage === stage || !canWrite) return;
		c.stage = stage; // optimistic; the listener confirms
		try {
			await callAction('crm:contact.stage', { id, stage });
		} catch (e) {
			moveError = errorText(e);
		}
	}

	// New contact
	let creating = $state(false);
	let saving = $state(false);
	let formError = $state<string | null>(null);
	const blank = (): ContactDraft => ({
		type,
		name: '',
		email: '',
		phone: '',
		company: '',
		linkedin: '',
		source: 'manual',
		tags: '',
		notes: ''
	});
	let draft = $state<ContactDraft>(blank());

	function openNew() {
		draft = blank();
		formError = null;
		creating = true;
	}

	async function create() {
		saving = true;
		formError = null;
		try {
			const res = await callAction<{ id: string }>('crm:contact.create', {
				...draft,
				tags: draft.tags.split(',')
			});
			creating = false;
			goto(`/crm/${res.id}`);
		} catch (e) {
			formError = errorText(e);
		} finally {
			saving = false;
		}
	}
</script>

{#if cfg.value}
	{@const config = cfg.value}
	<div class="space-y-4">
		<div class="flex items-center justify-between gap-3">
			<div class="flex rounded-lg border border-line/70 bg-white p-0.5">
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

			<div class="flex min-w-0 items-center gap-2">
				<div class="relative">
					<Search class="pointer-events-none absolute top-2 left-2.5 h-4 w-4 text-ink-soft/60" />
					<input
						class="input w-60 pl-8"
						placeholder="Search name, email, company, tag"
						bind:value={search}
					/>
				</div>
				<label class="flex items-center gap-1.5 text-sm whitespace-nowrap">
					<input type="checkbox" class="rounded text-primary-600" bind:checked={mine} /> Mine
				</label>
				<label class="flex items-center gap-1.5 text-sm whitespace-nowrap">
					<input type="checkbox" class="rounded text-primary-600" bind:checked={attentionOnly} /> Needs
					attention
				</label>
				<div class="flex rounded-lg border border-line/70 bg-white p-0.5">
					<button
						class="rounded-md p-1.5 {view === 'board'
							? 'bg-primary-50 text-primary-700'
							: 'text-ink-soft'}"
						title="Board"
						onclick={() => (view = 'board')}
					>
						<Columns3 class="h-4 w-4" />
					</button>
					<button
						class="rounded-md p-1.5 {view === 'list'
							? 'bg-primary-50 text-primary-700'
							: 'text-ink-soft'}"
						title="List"
						onclick={() => (view = 'list')}
					>
						<List class="h-4 w-4" />
					</button>
				</div>
				{#if canWrite}
					<button class="btn-primary" onclick={openNew}><Plus class="h-4 w-4" /> New</button>
				{/if}
			</div>
		</div>

		<FormError message={moveError} />

		{#if view === 'board'}
			<div class="flex gap-3 overflow-x-auto pb-4">
				{#each stages as stage (stage.id)}
					{@const cards = filtered.filter((c) => c.stage === stage.id)}
					<div
						class="flex min-w-44 flex-1 flex-col rounded-xl bg-primary-50/60 {stage.final
							? 'opacity-80'
							: ''}"
						role="list"
						ondragover={(e) => e.preventDefault()}
						ondrop={() => drop(stage.id)}
					>
						<div class="flex items-center justify-between px-3 py-2">
							<span class="text-xs font-bold tracking-wide text-ink-soft uppercase">
								{stage.label}
							</span>
							<span class="text-xs font-semibold text-ink-soft">{cards.length}</span>
						</div>
						<div class="flex min-h-24 flex-col gap-2 px-2 pb-2">
							{#each cards as c (c.id)}
								<a
									href="/crm/{c.id}"
									draggable={canWrite}
									ondragstart={() => (dragging = c.id)}
									class="block card px-3 py-2 hover:border-primary-300"
								>
									<div class="flex items-start justify-between gap-2">
										<span class="text-sm font-semibold">{c.name}</span>
										{#if c.needsAttention}<TriangleAlert
												class="h-3.5 w-3.5 shrink-0 text-warning"
											/>{/if}
									</div>
									{#if c.company}<div class="truncate text-xs text-ink-soft">{c.company}</div>{/if}
									<div class="mt-1.5 flex items-center justify-between text-[11px] text-ink-soft">
										<span class="truncate">{c.ownerName ?? 'No owner'}</span>
										<span class="shrink-0">{relative(c.lastActivityAt)}</span>
									</div>
								</a>
							{/each}
						</div>
					</div>
				{/each}
			</div>
		{:else}
			<div class="overflow-hidden card">
				<table class="w-full text-sm">
					<thead class="bg-canvas text-left text-xs text-ink-soft">
						<tr>
							<th class="px-4 py-2 font-semibold">Name</th>
							<th class="px-4 py-2 font-semibold">Company</th>
							<th class="px-4 py-2 font-semibold">Stage</th>
							<th class="px-4 py-2 font-semibold">Owner</th>
							<th class="px-4 py-2 font-semibold">Source</th>
							<th class="px-4 py-2 font-semibold">Last activity</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-line/40">
						{#each filtered as c (c.id)}
							<tr class="hover:bg-canvas">
								<td class="px-4 py-2">
									<a href="/crm/{c.id}" class="font-semibold hover:text-primary-700">{c.name}</a>
									<div class="text-xs text-ink-soft">{c.email}</div>
								</td>
								<td class="px-4 py-2">{c.company || '—'}</td>
								<td class="px-4 py-2">{stageLabel(config, c.type, c.stage)}</td>
								<td class="px-4 py-2">{c.ownerName ?? '—'}</td>
								<td class="px-4 py-2 capitalize">{c.source}</td>
								<td class="px-4 py-2 whitespace-nowrap">
									{relative(c.lastActivityAt)}
									{#if c.needsAttention}<TriangleAlert
											class="ml-1 inline h-3.5 w-3.5 text-warning"
										/>{/if}
								</td>
							</tr>
						{:else}
							<tr>
								<td colspan="6" class="px-4 py-8 text-center text-ink-soft">No contacts match.</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>

	<Modal bind:open={creating} title="New contact">
		<div class="space-y-3">
			<FormError message={formError} />
			<ContactForm bind:draft {config} creating />
		</div>
		{#snippet footer()}
			<button class="btn-ghost" onclick={() => (creating = false)}>Cancel</button>
			<button class="btn-primary" onclick={create} disabled={saving || !draft.name.trim()}>
				Create
			</button>
		{/snippet}
	</Modal>
{:else}
	<p class="text-sm text-ink-soft">Loading…</p>
{/if}
