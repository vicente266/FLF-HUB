<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';

	// Skills live in a tab of Knowledge; this address stays for old links.
	onMount(() => goto('/knowledge?tab=skills', { replaceState: true }));
</script>
