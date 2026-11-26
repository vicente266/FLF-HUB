<script lang="ts">
	import { moveNotice, undoMove } from '$lib/helpers/crmConfig.svelte';

	// "Moved to X · Undo" for the latest stage move; with `contactId`, only that contact's (its page).
	let {
		contactId,
		onerror,
		class: cls = ''
	}: { contactId?: string; onerror: (message: string | null) => void; class?: string } = $props();

	let n = $derived(
		moveNotice.current && (!contactId || moveNotice.current.contactId === contactId)
			? moveNotice.current
			: null
	);
</script>

{#if n}
	<div
		class="flex w-fit max-w-full {cls} items-center gap-2 rounded-md bg-primary-50 px-3 py-1.5 text-sm"
		role="status"
	>
		<span class="min-w-0 truncate">
			{contactId ? '' : `${n.name}: `}Moved to {n.stage}
		</span>
		<span class="text-ink-soft">·</span>
		<button
			class="font-semibold text-primary-700 hover:underline"
			onclick={async () => onerror(await undoMove())}
		>
			Undo
		</button>
	</div>
{/if}
