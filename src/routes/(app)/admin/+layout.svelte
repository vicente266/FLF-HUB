<script lang="ts">
	import Lock from '@lucide/svelte/icons/lock';
	import { me } from '$lib/stores';
	let { children } = $props();
</script>

{#if $me?.role === 'admin'}
	{@render children?.()}
{:else}
	<div class="mx-auto mt-10 max-w-md card px-8 py-10 text-center">
		<div class="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-primary-50">
			<Lock class="h-5 w-5 text-primary-600" />
		</div>
		<h2 class="mt-4 text-lg font-bold">Admins only</h2>
		<p class="mt-2 text-sm text-ink-soft">
			Only admins can manage users and groups. Ask an admin if you need someone added, removed or
			given access.
		</p>
		<a href="/" class="mt-6 btn-primary">Go to Home</a>
	</div>
{/if}
