<script lang="ts">
	import { onMount } from 'svelte';
	import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
	import { doc, onSnapshot } from 'firebase/firestore';
	import { goto } from '$app/navigation';
	import { auth, db } from '$lib/firebase';
	import { callAction } from '$lib/actions';
	import { me, type Me } from '$lib/stores';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import Header from '$lib/components/Header.svelte';
	import Logo from '$lib/components/Logo.svelte';

	let { children } = $props();
	let checking = $state(true);
	/** Signed in but not approved yet: waiting for an admin, watching their own profile. */
	let waiting = $state<{ email: string } | null>(null);
	let stopWaiting: (() => void) | null = null;

	async function enter(user: User): Promise<boolean> {
		const res = await callAction<{ valid: boolean; role: Me['role']; permissions: string[] }>(
			'core:user.validate'
		);
		if (!res.valid) return false;
		// Refresh the token until it carries the role the Firestore rules read: right after an
		// approval, the claim follows the profile by a moment (the syncUserRole trigger).
		for (let i = 0; i < 8; i++) {
			const role = (await user.getIdTokenResult(true)).claims.role;
			if (role === 'user' || role === 'admin') break;
			await new Promise((r) => setTimeout(r, 1500));
		}
		me.set({
			uid: user.uid,
			email: user.email ?? '',
			name: user.displayName ?? '',
			role: res.role,
			permissions: res.permissions
		});
		return true;
	}

	/**
	 * Not approved yet: stay signed in and watch the person's own profile (the rules let them read
	 * it). When an admin gives access, the role claim is refreshed and they are let in, with no
	 * second sign-in.
	 */
	function wait(user: User) {
		waiting = { email: user.email ?? '' };
		stopWaiting?.();
		stopWaiting = onSnapshot(doc(db, 'user', user.uid), async (snap) => {
			const role = snap.data()?.role;
			if (!role || role === 'guest') return;
			try {
				if (await enter(user)) {
					stopWaiting?.();
					stopWaiting = null;
					waiting = null;
				}
			} catch (e) {
				// The claim may lag the profile by a moment: the next snapshot or a reload retries.
				console.error('enter after approval failed', e);
			}
		});
	}

	onMount(() => {
		const unsub = onAuthStateChanged(auth, async (user) => {
			checking = true;
			waiting = null;
			stopWaiting?.();
			stopWaiting = null;
			me.set(null);
			if (!user) {
				// Back to this page after signing in (the Claude consent page needs it).
				goto(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
				return;
			}
			try {
				if (!(await enter(user))) wait(user);
				checking = false;
			} catch (e) {
				console.error('user.validate failed', e);
				await signOut(auth);
				goto('/login');
			}
		});
		return () => {
			unsub();
			stopWaiting?.();
		};
	});
</script>

{#if checking}
	<div class="flex min-h-screen items-center justify-center text-sm text-ink-soft">Loading…</div>
{:else if waiting}
	<div class="flex min-h-screen items-center justify-center px-4">
		<div class="w-full max-w-md card px-8 py-10 text-center">
			<div class="flex justify-center"><Logo /></div>
			<div class="mt-4 eyebrow">Founders for Life Fellowship</div>
			<h1 class="mt-2 text-xl font-bold">Waiting for access</h1>
			<p class="mt-2 text-sm text-ink-soft">
				You're signed in as <strong>{waiting.email}</strong>. An admin needs to give you access;
				this page lets you in on its own as soon as they do.
			</p>
			<button class="mt-6 btn-ghost" onclick={() => signOut(auth)}>Use another account</button>
		</div>
	</div>
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
