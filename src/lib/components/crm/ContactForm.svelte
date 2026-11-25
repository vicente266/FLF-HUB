<script lang="ts">
	import { collection, query, orderBy, limit } from 'firebase/firestore';
	import { db } from '$lib/firebase';
	import { listen } from '$lib/utils';
	import { sourceLabel } from '$lib/helpers/crmConfig.svelte';
	import type { ContactDraft, CrmConfig, Strategy, TeamUser } from '$lib/types/crm';

	let {
		draft = $bindable(),
		config,
		creating = false,
		team = []
	}: { draft: ContactDraft; config: CrmConfig; creating?: boolean; team?: TeamUser[] } = $props();

	let stages = $derived(config.pipelines[draft.type]?.stages ?? []);
	// Another type: its own first stage.
	$effect(() => {
		if (creating && !stages.some((s) => s.id === draft.stage)) draft.stage = stages[0]?.id ?? '';
	});

	// A Partner is an organisation (company) with a main contact (name), a segment and a strategy.
	let partner = $derived(draft.type === 'partner');
	let strategies = $state<Strategy[]>([]);
	$effect(() => {
		if (!partner) return;
		return listen<Strategy>(
			query(collection(db, 'strategy'), orderBy('createdAt'), limit(200)),
			(rows) => (strategies = rows)
		);
	});
</script>

<div class="grid grid-cols-1 gap-3 md:grid-cols-2">
	{#if creating}
		<div>
			<label class="label" for="type">Type</label>
			<select id="type" class="input" bind:value={draft.type}>
				{#each config.types as t (t)}<option value={t}>{config.pipelines[t].label}</option>{/each}
			</select>
		</div>
		<div>
			<label class="label" for="source">Source</label>
			<select id="source" class="input" bind:value={draft.source}>
				{#each config.sources as s (s)}<option value={s}>{sourceLabel(s)}</option>{/each}
			</select>
		</div>
		<div>
			<label class="label" for="stage">Stage</label>
			<select id="stage" class="input" bind:value={draft.stage}>
				{#each stages as s (s.id)}<option value={s.id}>{s.label}</option>{/each}
			</select>
		</div>
		<div>
			<label class="label" for="owner">Owner</label>
			<select id="owner" class="input" bind:value={draft.ownerUid}>
				<option value="">No owner</option>
				{#each team as u (u.id)}<option value={u.id}>{u.name || u.email}</option>{/each}
			</select>
		</div>
	{/if}
	{#if partner}
		<div class="md:col-span-2">
			<label class="label" for="company">Organisation</label>
			<input
				id="company"
				class="input"
				bind:value={draft.company}
				placeholder="e.g. Seedcamp, IE University"
				required
			/>
		</div>
		<div>
			<label class="label" for="segment">Segment</label>
			<select id="segment" class="input" bind:value={draft.segment}>
				<option value="">—</option>
				{#each config.segments as s (s.id)}<option value={s.id}>{s.label}</option>{/each}
			</select>
		</div>
		<div>
			<label class="label" for="strategy">Strategy</label>
			<select id="strategy" class="input" bind:value={draft.strategyId}>
				<option value="">None</option>
				{#each strategies as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
			</select>
		</div>
		<div class="md:col-span-2">
			<label class="label" for="name">Main contact</label>
			<input id="name" class="input" bind:value={draft.name} placeholder="Name of the person" />
		</div>
	{:else}
		<div class="md:col-span-2">
			<label class="label" for="name">Name</label>
			<input id="name" class="input" bind:value={draft.name} required />
		</div>
	{/if}
	<div>
		<label class="label" for="email">Email</label>
		<input id="email" class="input" type="email" bind:value={draft.email} />
	</div>
	<div>
		<label class="label" for="phone">Phone</label>
		<input id="phone" class="input" bind:value={draft.phone} />
	</div>
	{#if !partner}
		<div>
			<label class="label" for="company">Company</label>
			<input id="company" class="input" bind:value={draft.company} />
		</div>
	{/if}
	<div class={partner ? 'md:col-span-2' : ''}>
		<label class="label" for="linkedin">LinkedIn</label>
		<input
			id="linkedin"
			class="input"
			bind:value={draft.linkedin}
			placeholder="https://linkedin.com/in/…"
		/>
	</div>
	<div class="md:col-span-2">
		<label class="label" for="tags">Tags (comma separated)</label>
		<input id="tags" class="input" bind:value={draft.tags} />
	</div>
	<div class="md:col-span-2">
		<label class="label" for="notes">Notes</label>
		<textarea id="notes" class="input" rows="3" bind:value={draft.notes}></textarea>
	</div>
</div>
