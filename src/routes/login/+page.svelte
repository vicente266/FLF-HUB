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
	import Logo from '$lib/components/Logo.svelte';
	import FormError from '$lib/components/shared/FormError.svelte';

	let email = $state('');
	let password = $state('');
	let error = $state<string | null>(null);
	let info = $state<string | null>(null);
	let busy = $state(false);

	/** Where to go after signing in: a path on this site only, never another origin. */
	function target(): string {
		const next = new URLSearchParams(location.search).get('next') ?? '/';
		return next.startsWith('/') && !next.startsWith('//') ? next : '/';
	}

	onMount(() => {
		if (new URLSearchParams(location.search).get('invalid') === '1') {
			error = 'Your account is not approved yet. Ask an admin to give you access.';
		}
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
		} catch {
			error = 'Wrong email or password.';
		} finally {
			busy = false;
		}
	}

	async function withGoogle() {
		error = null;
		try {
			await signInWithPopup(auth, new GoogleAuthProvider());
			goto(target());
		} catch {
			error = 'Google sign-in failed. Please try again.';
		}
	}

	async function reset() {
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
			<h1 class="mt-2 text-2xl font-bold">Sherpa Hub</h1>
			<p class="mt-1 text-sm text-ink-soft">Sign in to continue.</p>
		</div>

		<form class="mt-8 space-y-3" onsubmit={withEmail}>
			<FormError message={error} />
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
			<button class="btn-primary w-full py-2" disabled={busy}>
				Sign in <ArrowRight class="h-4 w-4" />
			</button>
		</form>

		<div class="my-5 flex items-center gap-3 text-xs text-ink-soft/70">
			<div class="h-px flex-1 bg-line/60"></div>
			or
			<div class="h-px flex-1 bg-line/60"></div>
		</div>
		<button class="btn-ghost w-full py-2" onclick={withGoogle}>Continue with Google</button>

		<div class="mt-6 text-center text-xs text-ink-soft">
			<button class="hover:text-primary-700" onclick={reset}>Forgot password?</button>
		</div>
	</div>
</div>
