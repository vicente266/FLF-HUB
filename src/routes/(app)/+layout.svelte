<script lang="ts">
	import { onMount } from 'svelte';
	import { onAuthStateChanged, signOut } from 'firebase/auth';
	import { goto } from '$app/navigation';
	import { auth } from '$lib/firebase';
	import { callAction } from '$lib/actions';
	import { me, type Me } from '$lib/stores';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import Header from '$lib/components/Header.svelte';

	let { children } = $props();
	let checking = $state(true);

	onMount(() =>
		onAuthStateChanged(auth, async (user) => {
			checking = true;
			me.set(null);
			if (!user) {
				goto('/login');
				return;
			}
			try {
				const res = await callAction<{ valid: boolean; role: Me['role']; permissions: string[] }>(
					'core:user.validate'
				);
				if (!res.valid) {
					await signOut(auth);
					goto('/login?invalid=1');
					return;
				}
				// Refresh the token so the role claim the Firestore rules read is current.
				await user.getIdToken(true);
				me.set({
					uid: user.uid,
					email: user.email ?? '',
					name: user.displayName ?? '',
					role: res.role,
					permissions: res.permissions
				});
				checking = false;
			} catch (e) {
				console.error('user.validate failed', e);
				await signOut(auth);
				goto('/login');
			}
		})
	);
</script>

{#if checking}
	<div class="flex min-h-screen items-center justify-center text-sm text-ink-soft">Loading…</div>
{:else}
	<div class="flex h-dvh">
		<aside class="flex w-56 shrink-0 flex-col gap-4 border-r border-line/60 bg-white px-3 pb-4">
			<Sidebar />
		</aside>
		<div class="flex min-w-0 flex-1 flex-col">
			<Header />
			<main class="min-h-0 flex-1 overflow-y-auto px-6 py-5">
				{@render children?.()}
			</main>
		</div>
	</div>
{/if}
