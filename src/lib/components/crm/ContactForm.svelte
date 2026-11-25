<script lang="ts">
	import { collection, query, orderBy, limit } from 'firebase/firestore';
	import { db } from '$lib/firebase';
	import { listen } from '$lib/utils';
	import type { ContactDraft, CrmConfig, Strategy } from '$lib/types/crm';

	let {
		draft = $bindable(),
		config,
		creating = false
	}: { draft: ContactDraft; config: CrmConfig; creating?: boolean } = $props();

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

<div class="grid grid-cols-2 gap-3">
	{#if creating}
		<div>
			<label class="label" for="type">Type</label>
			<select id="type" class="input" bind:value={draft.type}>
				{#each config.types as t (t)}<option value={t}>{config.pipelines[t].label}</option>{/each}
			</select>
		</div>
		<div>
			<label class="label" for="source">Source</label>
			<select id="source" class="input capitalize" bind:value={draft.source}>
				{#each config.sources as s (s)}<option value={s}>{s}</option>{/each}
			</select>
		</div>
	{/if}
	{#if partner}
		<div class="col-span-2">
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
		<div class="col-span-2">
			<label class="label" for="name">Main contact</label>
			<input id="name" class="input" bind:value={draft.name} placeholder="Name of the person" />
		</div>
	{:else}
		<div class="col-span-2">
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
	<div class={partner ? 'col-span-2' : ''}>
		<label class="label" for="linkedin">LinkedIn</label>
		<input
			id="linkedin"
			class="input"
			bind:value={draft.linkedin}
			placeholder="https://linkedin.com/in/…"
		/>
	</div>
	<div class="col-span-2">
		<label class="label" for="tags">Tags (comma separated)</label>
		<input id="tags" class="input" bind:value={draft.tags} />
	</div>
	<div class="col-span-2">
		<label class="label" for="notes">Notes</label>
		<textarea id="notes" class="input" rows="3" bind:value={draft.notes}></textarea>
	</div>
</div>
