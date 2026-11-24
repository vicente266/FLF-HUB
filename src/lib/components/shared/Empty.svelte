<script lang="ts">
	import type { Snippet } from 'svelte';
	let { title, children }: { title: string; children?: Snippet } = $props();
</script>

<div class="card px-6 py-10 text-center">
	<p class="font-semibold">{title}</p>
	{#if children}<div class="mt-1 text-sm text-ink-soft">{@render children()}</div>{/if}
</div>
