<script lang="ts">
	import { signOut } from 'firebase/auth';
	import { goto } from '$app/navigation';
	import LogOut from '@lucide/svelte/icons/log-out';
	import Menu from '@lucide/svelte/icons/menu';
	import { auth } from '$lib/firebase';
	import { me, pageTitle } from '$lib/stores';

	/** `onmenu` opens the navigation drawer; its button only shows below 1024px. */
	let { onmenu, menuOpen = false }: { onmenu?: () => void; menuOpen?: boolean } = $props();

	async function logout() {
		await signOut(auth);
		goto('/login');
	}
</script>

<header
	class="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line/60 bg-canvas/90 px-4 backdrop-blur lg:px-6"
>
	{#if onmenu}
		<button
			class="-mr-2 btn-ghost shrink-0 px-2 lg:hidden"
			aria-label="Open navigation"
			aria-controls="app-nav"
			aria-expanded={menuOpen}
			onclick={onmenu}
		>
			<Menu class="h-4 w-4" />
		</button>
	{/if}
	<div class="min-w-0 flex-1">
		<h1 class="truncate text-base font-bold text-ink">{$pageTitle.title}</h1>
		{#if $pageTitle.subtitle}
			<p class="truncate text-xs text-ink-soft">{$pageTitle.subtitle}</p>
		{/if}
	</div>
	{#if $me}
		<div class="flex shrink-0 items-center gap-3">
			<div class="hidden text-right leading-tight sm:block">
				<div class="text-sm font-semibold">{$me.name || $me.email}</div>
				<div class="text-[11px] text-ink-soft capitalize">{$me.role}</div>
			</div>
			<button class="btn-ghost px-2" onclick={logout} title="Sign out" aria-label="Sign out">
				<LogOut class="h-4 w-4" />
			</button>
		</div>
	{/if}
</header>
