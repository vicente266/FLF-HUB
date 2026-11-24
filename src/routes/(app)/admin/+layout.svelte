<script lang="ts">
	import { me } from '$lib/stores';
	let { children } = $props();
</script>

{#if $me?.role === 'admin'}
	{@render children?.()}
{:else}
	<p class="text-sm text-ink-soft">Only admins can open this page.</p>
{/if}
