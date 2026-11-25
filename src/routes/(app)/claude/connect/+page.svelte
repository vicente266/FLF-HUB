<script lang="ts">
	import { onMount } from 'svelte';
	import {
		EmailAuthProvider,
		GoogleAuthProvider,
		reauthenticateWithCredential,
		reauthenticateWithPopup
	} from 'firebase/auth';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import { auth } from '$lib/firebase';
	import { callAction, errorText } from '$lib/actions';
	import { me } from '$lib/stores';
	import { setTitle } from '$lib/utils';
	import FormError from '$lib/components/shared/FormError.svelte';

	setTitle('Connect Claude', 'Approve access to the FLF Hub');

	interface Client {
		name: string;
		sendsTo: string;
		registeredAt: string | null;
		error: string | null;
		denyUrl: string;
	}

	/** The OAuth request /authorize checked, passed through unchanged. */
	let params = $state<Record<string, string>>({});
	let client = $state<Client | null>(null);
	let error = $state<string | null>(null);
	let busy = $state(false);
	let framed = $state(false);
	let password = $state('');

	const usesPassword = () =>
		auth.currentUser?.providerData.some((p) => p.providerId === 'password') ?? false;

	onMount(async () => {
		// Never show an Approve button inside a frame (clickjacking).
		framed = window.top !== window.self;
		if (framed) return;
		params = Object.fromEntries(new URLSearchParams(location.search));
		try {
			client = await callAction<Client>('core:claude.client', params);
		} catch (e) {
			error = errorText(e);
		}
	});

	async function approve() {
		const user = auth.currentUser;
		if (!user) return;
		busy = true;
		error = null;
		try {
			// A fresh sign-in, so the server sees a recent auth_time: the Hub keeps people signed in
			// for weeks, and approving access must be a deliberate act.
			if (usesPassword()) {
				await reauthenticateWithCredential(
					user,
					EmailAuthProvider.credential(user.email ?? '', password)
				);
			} else {
				await reauthenticateWithPopup(user, new GoogleAuthProvider());
			}
			await user.getIdToken(true);
			const res = await callAction<{ redirect: string }>('core:claude.approve', params);
			location.href = res.redirect;
		} catch (e) {
			error = errorText(e);
			busy = false;
		}
	}
</script>

{#if !framed}
	<div class="mx-auto mt-6 max-w-md">
		<div class="card px-6 py-6">
			<div class="flex items-center gap-2 text-primary-700">
				<ShieldCheck class="h-5 w-5" />
				<span class="eyebrow">Connect Claude</span>
			</div>
			<FormError message={error} />
			{#if client}
				{#if client.error}
					<p class="mt-3 text-sm text-danger">{client.error}</p>
				{:else}
					<h2 class="mt-3 text-lg font-bold">
						<span class="text-primary-700">{client.name}</span> wants to use the FLF Hub as you
					</h2>
					<ul class="mt-3 space-y-1 text-sm text-ink-soft">
						<li>Signed in as <strong>{$me?.email}</strong>.</li>
						<li>
							It can read and change what your Hub profile allows: contacts, tasks, reports,
							automations, connections.
						</li>
						<li>Changes show in the Hub marked <strong>via Claude</strong>.</li>
						<li>After you approve, you are sent back to <strong>{client.sendsTo}</strong>.</li>
						<li>Use only the company’s Claude. Disconnect any time from the Claude page.</li>
					</ul>
					{#if usesPassword()}
						<div class="mt-4">
							<label class="label" for="pw">Confirm your password</label>
							<input
								id="pw"
								class="input"
								type="password"
								autocomplete="current-password"
								bind:value={password}
							/>
						</div>
					{/if}
					<div class="mt-5 flex justify-end gap-2">
						<a class="btn-ghost" href={client.denyUrl}>Cancel</a>
						<button
							class="btn-primary"
							onclick={approve}
							disabled={busy || (usesPassword() && !password)}
						>
							Approve access
						</button>
					</div>
				{/if}
			{:else if !error}
				<p class="mt-3 text-sm text-ink-soft">Checking the request…</p>
			{/if}
		</div>
	</div>
{/if}
