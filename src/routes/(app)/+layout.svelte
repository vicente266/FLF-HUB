<script lang="ts">
	import { onMount } from 'svelte';
	import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
	import { doc, onSnapshot } from 'firebase/firestore';
	import { afterNavigate, goto } from '$app/navigation';
	import { auth, db } from '$lib/firebase';
	import { callAction } from '$lib/actions';
	import { FOCUSABLE, trapTab } from '$lib/utils';
	import { me, pageTitle, type Me } from '$lib/stores';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import Header from '$lib/components/Header.svelte';
	import Logo from '$lib/components/Logo.svelte';

	let { children } = $props();
	let checking = $state(true);
	/** Signed in but not approved yet: waiting for an admin, watching their own profile. */
	let waiting = $state<{ email: string } | null>(null);
	let stopWaiting: (() => void) | null = null;

	/** Below 1024px the sidebar is a drawer opened from the header's menu button. */
	let navOpen = $state(false);
	let drawer = $state<HTMLElement>();
	let menuButton: HTMLElement | null = null;

	function openNav() {
		menuButton = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		navOpen = true;
	}

	function closeNav() {
		if (!navOpen) return;
		navOpen = false;
		menuButton?.focus();
	}

	$effect(() => {
		if (navOpen) drawer?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
	});

	afterNavigate(() => {
		navOpen = false;
	});

	function onkeydown(e: KeyboardEvent) {
		if (!navOpen || !drawer) return;
		if (e.key === 'Escape') closeNav();
		else if (e.key === 'Tab') trapTab(drawer, e);
	}

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

<svelte:head>
	<title>{$pageTitle.title ? `${$pageTitle.title} · FLF Hub` : 'FLF Hub'}</title>
</svelte:head>

<svelte:window {onkeydown} />

{#if checking}
	<div class="flex min-h-screen items-center justify-center text-sm text-ink-soft">Loading…</div>
{:else if waiting}
	<div class="flex min-h-screen items-center justify-center px-4">
		<div class="w-full max-w-md card px-8 py-10 text-center">
			<div class="flex justify-center"><Logo /></div>
			<div class="mt-4 eyebrow">Founders for Life Fellowship</div>
			<h1 class="mt-2 text-xl font-bold">Waiting for access to the FLF Hub</h1>
			<p class="mt-2 text-sm text-ink-soft">
				You're signed in as <strong>{waiting.email}</strong>. An admin needs to give you access;
				this page lets you in on its own as soon as they do.
			</p>
			<button class="mt-6 btn-ghost" onclick={() => signOut(auth)}>Use another account</button>
		</div>
	</div>
{:else}
	<div class="flex h-dvh">
		<aside
			class="hidden w-56 shrink-0 flex-col gap-4 border-r border-line/60 bg-white px-3 pb-4 lg:flex"
		>
			<Sidebar />
		</aside>
		{#if navOpen}
			<div class="fixed inset-0 z-50 lg:hidden">
				<!-- The backdrop is mouse/touch-only; keyboard users close with Esc. -->
				<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
				<div class="absolute inset-0 bg-navy/40" onclick={closeNav}></div>
				<div
					bind:this={drawer}
					id="app-nav"
					class="absolute inset-y-0 left-0 flex w-64 max-w-[85vw] flex-col gap-4 overflow-y-auto bg-white px-3 pb-4 shadow-xl"
					role="dialog"
					aria-modal="true"
					aria-label="Navigation"
				>
					<Sidebar />
				</div>
			</div>
		{/if}
		<div class="flex min-w-0 flex-1 flex-col">
			<Header onmenu={openNav} menuOpen={navOpen} />
			<main class="min-h-0 flex-1 overflow-y-auto px-4 py-5 lg:px-6">
				{@render children?.()}
			</main>
		</div>
	</div>
{/if}
