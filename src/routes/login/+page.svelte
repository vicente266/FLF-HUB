<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		GoogleAuthProvider,
		onAuthStateChanged,
		signInWithEmailAndPassword,
		signInWithPopup,
		sendPasswordResetEmail
	} from 'firebase/auth';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import { auth } from '$lib/firebase';
	import { useEmulator } from '$lib/env';
	import Logo from '$lib/components/Logo.svelte';
	import FormError from '$lib/components/shared/FormError.svelte';

	let email = $state('');
	let password = $state('');
	let error = $state<string | null>(null);
	let info = $state<string | null>(null);
	let busy = $state(false);

	/** Firebase Auth error code, e.g. `auth/network-request-failed`. */
	const codeOf = (e: unknown) =>
		e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : '';
	const NETWORK = "Couldn't reach the sign-in service. Check your connection and try again.";

	/** Where to go after signing in: a path on this site only, never another origin. */
	function target(): string {
		const next = new URLSearchParams(location.search).get('next') ?? '/';
		return next.startsWith('/') && !next.startsWith('//') ? next : '/';
	}

	onMount(() => {
		return onAuthStateChanged(auth, (u) => {
			if (u && !error) goto(target());
		});
	});

	async function withEmail(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		error = null;
		try {
			await signInWithEmailAndPassword(auth, email.trim(), password);
			goto(target());
		} catch (e) {
			error = codeOf(e) === 'auth/network-request-failed' ? NETWORK : 'Wrong email or password.';
		} finally {
			busy = false;
		}
	}

	async function withGoogle() {
		error = null;
		try {
			await signInWithPopup(auth, new GoogleAuthProvider());
			goto(target());
		} catch (e) {
			const code = codeOf(e);
			// Closing the popup (or opening a second one) is the person's choice, not an error.
			if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return;
			error =
				code === 'auth/network-request-failed'
					? NETWORK
					: 'Google sign-in failed. Please try again.';
		}
	}

	async function reset() {
		error = null;
		info = null;
		if (!email.trim()) {
			error = 'Type your email first.';
			return;
		}
		await sendPasswordResetEmail(auth, email.trim()).catch(() => {});
		info = 'If that email has an account, a reset link is on its way.';
	}
</script>

<div class="relative flex min-h-screen items-center justify-center overflow-hidden px-4">
	<!-- The website's mountain ridge -->
	<svg
		class="absolute inset-x-0 bottom-0 w-full"
		viewBox="0 0 1440 90"
		preserveAspectRatio="none"
		aria-hidden="true"
	>
		<path
			d="M0 30 240 10l240 30 240-35 240 30 240-25 240 30v50H0z"
			fill="var(--color-primary-200)"
			opacity=".6"
		/>
		<path
			d="M0 55 300 30l240 30 240-35 240 30 240-25 180 20v40H0z"
			fill="var(--color-primary-300)"
			opacity=".8"
		/>
	</svg>

	<div class="relative w-full max-w-sm card px-8 py-10 shadow-sm">
		<div class="flex flex-col items-center text-center">
			<Logo size="lg" />
			<p class="mt-5 eyebrow">Founders for Life Fellowship</p>
			<h1 class="mt-2 text-2xl font-bold">FLF Hub</h1>
			<p class="mt-1 text-sm text-ink-soft">Sign in to continue.</p>
		</div>

		<div class="mt-8 space-y-3">
			<FormError message={error} />
			<button class="btn-primary w-full py-2.5" onclick={withGoogle}>
				Continue with Google <ArrowRight class="h-4 w-4" />
			</button>
			<p class="text-center text-xs text-ink-soft">
				Use your FLF Google account. New accounts wait for an admin to approve them.
			</p>
		</div>

		{#if useEmulator}
			<!-- Local emulator only: seeded test users sign in with a password. -->
			<form class="mt-6 space-y-3 border-t border-line/60 pt-5" onsubmit={withEmail}>
				<p class="text-xs font-semibold text-warning">Emulator only</p>
				{#if info}<p class="text-sm text-primary-700">{info}</p>{/if}
				<div>
					<label class="label" for="email">Email address</label>
					<input
						id="email"
						class="input"
						type="email"
						autocomplete="email"
						bind:value={email}
						required
					/>
				</div>
				<div>
					<label class="label" for="password">Password</label>
					<input
						id="password"
						class="input"
						type="password"
						autocomplete="current-password"
						bind:value={password}
						required
					/>
				</div>
				<button class="btn-ghost w-full py-2" disabled={busy}>Sign in with password</button>
				<button
					type="button"
					class="w-full text-xs text-ink-soft hover:text-primary-700"
					onclick={reset}
				>
					Forgot password?
				</button>
			</form>
		{/if}
	</div>
</div>
