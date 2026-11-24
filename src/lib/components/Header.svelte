<script lang="ts">
	import { signOut } from 'firebase/auth';
	import { goto } from '$app/navigation';
	import LogOut from '@lucide/svelte/icons/log-out';
	import { auth } from '$lib/firebase';
	import { me, pageTitle } from '$lib/stores';

	async function logout() {
		await signOut(auth);
		goto('/login');
	}
</script>

<header
	class="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line/60 bg-canvas/90 px-6 backdrop-blur"
>
	<div class="min-w-0">
		<h1 class="truncate text-base font-bold text-ink">{$pageTitle.title}</h1>
		{#if $pageTitle.subtitle}
			<p class="truncate text-xs text-ink-soft">{$pageTitle.subtitle}</p>
		{/if}
	</div>
	{#if $me}
		<div class="flex shrink-0 items-center gap-3">
			<div class="text-right leading-tight">
				<div class="text-sm font-semibold">{$me.name || $me.email}</div>
				<div class="text-[11px] text-ink-soft capitalize">{$me.role}</div>
			</div>
			<button class="btn-ghost px-2" onclick={logout} title="Sign out">
				<LogOut class="h-4 w-4" />
			</button>
		</div>
	{/if}
</header>
