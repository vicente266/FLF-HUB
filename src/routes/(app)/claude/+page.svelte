<script lang="ts">
	import { onMount } from 'svelte';
	import Copy from '@lucide/svelte/icons/copy';
	import Check from '@lucide/svelte/icons/check';
	import Unplug from '@lucide/svelte/icons/unplug';
	import { callAction, errorText } from '$lib/actions';
	import { me } from '$lib/stores';
	import { hasPermission, setTitle, formatDate, relative } from '$lib/utils';
	import type { ClaudeConnection } from '$lib/types/claude';
	import FormError from '$lib/components/shared/FormError.svelte';

	setTitle('Claude', 'Use and manage the whole Hub from Claude');

	const canConnect = hasPermission('claude.self.connect');
	const isAdmin = $me?.role === 'admin';

	let mine = $state<ClaudeConnection[]>([]);
	let all = $state<ClaudeConnection[]>([]);
	let url = $state('');
	let error = $state<string | null>(null);
	let copied = $state<string | null>(null);

	async function load() {
		error = null;
		try {
			const res = await callAction<{ connections: ClaudeConnection[]; connectorUrl: string }>(
				'core:claude.connections'
			);
			mine = res.connections;
			url = res.connectorUrl;
			if (isAdmin)
				all = (await callAction<{ rows: ClaudeConnection[] }>('core:claude.admin.list')).rows;
		} catch (e) {
			error = errorText(e);
		}
	}
	onMount(load);

	let command = $derived(url ? `claude mcp add --transport http --scope user flf-hub ${url}` : '');

	async function copy(label: string, text: string) {
		await navigator.clipboard.writeText(text);
		copied = label;
		setTimeout(() => (copied = null), 1500);
	}

	async function end(target: 'core:claude.disconnect' | 'core:claude.admin.revoke', id: string) {
		if (!confirm('Disconnect this app? Claude loses access to the Hub straight away.')) return;
		try {
			await callAction(target, { id });
			await load();
		} catch (e) {
			error = errorText(e);
		}
	}

	const EXAMPLES = [
		'What needs my attention in the pipeline today?',
		'Add Marta Ruiz (marta@stackr.io, Stackr) as a prospective Fellow from a referral and note our call.',
		'Move Amara Okafor to Offer and give me a task to send the pledge on Friday.',
		'Which Investors have we not touched in two weeks?',
		'Is every connection working? Import the Knowledge folder now.'
	];
</script>

<div class="mx-auto max-w-5xl space-y-4">
	<FormError message={error} />

	<section class="card px-5 py-4">
		<p class="eyebrow">Claude connector</p>
		<h2 class="mt-1 text-lg font-bold">Everything in the Hub, from Claude</h2>
		<p class="mt-1 text-sm text-ink-soft">
			Ask Claude about contacts, tasks, reports, automations and connections, and have it make the
			changes. It acts as you, with exactly your permissions, and every change shows in the Hub
			marked <strong>via Claude</strong>. Claude asks you before each change.
		</p>
		<ul class="mt-3 grid grid-cols-2 gap-2 text-sm">
			{#each EXAMPLES as ex (ex)}
				<li class="rounded-lg bg-canvas px-3 py-2 text-ink-soft">“{ex}”</li>
			{/each}
		</ul>
	</section>

	{#if !canConnect}
		<div class="rounded-xl border border-warning/30 bg-warning/10 px-5 py-3 text-sm">
			Your profile does not include Claude access yet. Ask an admin to add you to a group with
			<strong>Claude — connect</strong>.
		</div>
	{/if}

	<div class="grid grid-cols-2 gap-4">
		<section class="card px-5 py-4">
			<h3 class="font-bold">claude.ai</h3>
			<ol class="mt-2 list-decimal space-y-1 pl-4 text-sm text-ink-soft">
				<li>In claude.ai open <strong>Settings → Connectors</strong>.</li>
				<li>
					Pick <strong>FLF Hub</strong> (an Owner adds it once for the organisation), or
					<strong>Add custom connector</strong> with the address below.
				</li>
				<li>Click <strong>Connect</strong>, sign in to the Hub and approve.</li>
			</ol>
			<div class="mt-3">
				<div class="label">Connector address</div>
				{#if url}
					<div class="flex gap-2">
						<code class="min-w-0 flex-1 truncate rounded-lg bg-canvas px-3 py-1.5 text-xs">
							{url}
						</code>
						<button class="btn-ghost" onclick={() => copy('url', url)}>
							{#if copied === 'url'}<Check class="h-4 w-4" />{:else}<Copy class="h-4 w-4" />{/if} Copy
						</button>
					</div>
				{:else}
					<p class="text-xs text-ink-soft">
						Not available yet. A developer needs to finish the setup (Connections → Claude
						connector).
					</p>
				{/if}
			</div>
		</section>

		<section class="card px-5 py-4">
			<h3 class="font-bold">Claude Code</h3>
			<p class="mt-2 text-sm text-ink-soft">
				Signed in with the company’s claude.ai account, the organisation’s connector appears by
				itself. Otherwise add it once, then run <code>/mcp</code> to sign in:
			</p>
			{#if command}
				<div class="mt-3 flex gap-2">
					<code class="min-w-0 flex-1 truncate rounded-lg bg-canvas px-3 py-1.5 text-xs">
						{command}
					</code>
					<button class="btn-ghost" onclick={() => copy('cmd', command)}>
						{#if copied === 'cmd'}<Check class="h-4 w-4" />{:else}<Copy class="h-4 w-4" />{/if} Copy
					</button>
				</div>
			{/if}
		</section>
	</div>

	<section class="card">
		<div class="border-b border-line/60 px-5 py-3 font-bold">Your connected apps</div>
		<ul class="divide-y divide-line/40">
			{#each mine as c (c.id)}
				<li class="flex items-center gap-3 px-5 py-2.5 text-sm">
					<div class="min-w-0 flex-1">
						<div class="font-semibold">{c.clientName}</div>
						<div class="text-xs text-ink-soft">
							Sends to {c.sendsTo} · connected {formatDate(c.createdAt)} · ends {formatDate(
								c.endsAt
							)}
						</div>
					</div>
					<span class="text-xs text-ink-soft">used {relative(c.lastUsedAt)}</span>
					<button class="btn-ghost text-danger" onclick={() => end('core:claude.disconnect', c.id)}>
						<Unplug class="h-4 w-4" /> Disconnect
					</button>
				</li>
			{:else}
				<li class="px-5 py-4 text-sm text-ink-soft">
					No connected apps yet. Follow the steps above to connect claude.ai or Claude Code.
				</li>
			{/each}
		</ul>
	</section>

	{#if isAdmin}
		<section class="card">
			<div class="border-b border-line/60 px-5 py-3 font-bold">Everyone’s connections (admins)</div>
			<table class="w-full text-sm">
				<tbody class="divide-y divide-line/40">
					{#each all as c (c.id)}
						<tr>
							<td class="px-5 py-2 font-medium">{c.email}</td>
							<td class="px-5 py-2">{c.clientName}</td>
							<td class="px-5 py-2 text-xs text-ink-soft">
								since {formatDate(c.createdAt)} · used {relative(c.lastUsedAt)}
							</td>
							<td class="px-5 py-2 text-right">
								<button
									class="text-xs font-semibold text-danger"
									onclick={() => end('core:claude.admin.revoke', c.id)}
								>
									Disconnect
								</button>
							</td>
						</tr>
					{:else}
						<tr><td class="px-5 py-4 text-sm text-ink-soft">Nobody has connected yet.</td></tr>
					{/each}
				</tbody>
			</table>
		</section>
	{/if}
</div>
