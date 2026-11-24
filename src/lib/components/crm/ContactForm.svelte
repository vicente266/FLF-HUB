<script lang="ts">
	import type { ContactDraft, CrmConfig } from '$lib/types/crm';

	let {
		draft = $bindable(),
		config,
		creating = false
	}: { draft: ContactDraft; config: CrmConfig; creating?: boolean } = $props();
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
	<div class="col-span-2">
		<label class="label" for="name">Name</label>
		<input id="name" class="input" bind:value={draft.name} required />
	</div>
	<div>
		<label class="label" for="email">Email</label>
		<input id="email" class="input" type="email" bind:value={draft.email} />
	</div>
	<div>
		<label class="label" for="phone">Phone</label>
		<input id="phone" class="input" bind:value={draft.phone} />
	</div>
	<div>
		<label class="label" for="company">Company</label>
		<input id="company" class="input" bind:value={draft.company} />
	</div>
	<div>
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
