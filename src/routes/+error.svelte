<script lang="ts">
	import { page } from '$app/state';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import House from '@lucide/svelte/icons/house';
	import Logo from '$lib/components/Logo.svelte';

	let notFound = $derived(page.status === 404);
	let heading = $derived(
		notFound ? "This page doesn't exist" : page.error?.message || 'Something went wrong'
	);

	function back() {
		if (history.length > 1) history.back();
		else location.assign('/');
	}
</script>

<svelte:head>
	<title>{notFound ? 'Page not found' : 'Error'} · FLF Hub</title>
</svelte:head>

<div class="flex min-h-screen items-center justify-center px-4">
	<div class="w-full max-w-md card px-8 py-10 text-center">
		<div class="flex justify-center"><Logo /></div>
		<p class="mt-4 eyebrow">Error {page.status}</p>
		<h1 class="mt-2 text-xl font-bold">{heading}</h1>
		<p class="mt-2 text-sm text-ink-soft">
			{#if notFound}
				The link may be old or mistyped. Go back, or start again from Home.
			{:else}
				Try again in a moment. If it keeps happening, check Health or tell an admin.
			{/if}
		</p>
		<div class="mt-6 flex justify-center gap-2">
			<button type="button" class="btn-ghost" onclick={back}>
				<ArrowLeft class="h-4 w-4" /> Back
			</button>
			<a href="/" class="btn-primary"><House class="h-4 w-4" /> Home</a>
		</div>
	</div>
</div>
