<script lang="ts">
	import Save from '@lucide/svelte/icons/save';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import { callAction, errorText } from '$lib/actions';
	import type { KnowledgeEntry, KnowledgeOption, KnowledgeUseOption } from '$lib/types/knowledge';
	import Modal from '$lib/components/shared/Modal.svelte';
	import FormError from '$lib/components/shared/FormError.svelte';

	// Add or edit one entry. Owns its draft and the save call; the page's live listener shows the
	// result once the action returns. Ported from the EBS Hub's KnowledgeModal. An entry imported
	// from Drive keeps its title and text from Drive: here only how Claude uses it changes.
	let {
		open = $bindable(false),
		entry,
		uses,
		types,
		audiences,
		reviewEvery
	}: {
		open: boolean;
		/** The entry to edit, or null to add one. */
		entry: KnowledgeEntry | null;
		uses: KnowledgeUseOption[];
		types: KnowledgeOption[];
		audiences: KnowledgeOption[];
		reviewEvery: number[];
	} = $props();

	let draft = $state({
		label: '',
		description: '',
		expiredAt: '',
		use: 'relevant',
		topics: '',
		type: 'other',
		useWhen: '',
		audience: 'internal',
		reviewEvery: 6
	});
	let approved = $derived(entry?.status === 'approved');
	let saving = $state(false);
	let error = $state<string | null>(null);
	let imported = $derived(entry?.source === 'drive');

	// Reset the draft each time the modal opens, for the entry it opens on.
	$effect(() => {
		if (open) {
			draft = {
				label: entry?.label ?? '',
				description: entry?.description ?? '',
				expiredAt: entry?.expiredAt ?? '',
				use: entry?.use ?? 'relevant',
				topics: (entry?.topics ?? []).join(', '),
				type: entry?.type ?? 'other',
				useWhen: entry?.useWhen ?? '',
				audience: entry?.audience ?? 'internal',
				reviewEvery: entry?.reviewEvery ?? 6
			};
			error = null;
		}
	});

	/** Expiry set to yesterday: the entry is kept but no longer given to Claude. */
	function markExpired() {
		draft.expiredAt = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
	}

	async function save() {
		if (!imported && !draft.description.trim()) {
			error = 'Write the entry before saving.';
			return;
		}
		saving = true;
		error = null;
		try {
			const topics = draft.topics
				.split(',')
				.map((t) => t.trim())
				.filter(Boolean);
			const card = {
				expiredAt: draft.expiredAt.trim(),
				use: draft.use,
				topics,
				type: draft.type,
				useWhen: draft.useWhen.trim(),
				audience: draft.audience,
				reviewEvery: Number(draft.reviewEvery)
			};
			await callAction('core:knowledge.save', {
				id: entry?.id ?? null,
				entry: imported
					? card
					: { label: draft.label.trim(), description: draft.description.trim(), ...card }
			});
			open = false;
		} catch (e) {
			error = errorText(e);
		} finally {
			saving = false;
		}
	}
</script>

<Modal bind:open title={entry ? 'Edit entry' : 'Add entry'} width="max-w-2xl">
	<div class="space-y-3">
		{#if imported}
			<div class="rounded-lg bg-canvas px-3 py-2 text-sm">
				<div class="font-semibold">{entry?.label}</div>
				<p class="mt-0.5 text-xs text-ink-soft">
					Imported from the Knowledge folder: its title and text come from Drive.
					{#if entry?.url}<a
							href={entry.url}
							target="_blank"
							rel="noopener noreferrer"
							class="inline-flex items-center gap-1 text-primary-700"
						>
							Edit in Drive <ExternalLink class="h-3 w-3" />
						</a>{/if}
				</p>
			</div>
		{:else}
			<div>
				<label class="label" for="k-label">Label <span class="font-normal">(optional)</span></label>
				<input
					id="k-label"
					class="input"
					maxlength="80"
					bind:value={draft.label}
					placeholder="e.g. The Founder's Pledge"
				/>
			</div>
			<div>
				<label class="label" for="k-description">Description</label>
				<textarea
					id="k-description"
					class="input"
					rows="10"
					maxlength="8000"
					bind:value={draft.description}
					placeholder="e.g. Fellows pledge 3% of work income above the local average salary, for 10 years."
				></textarea>
			</div>
		{/if}
		<div>
			<label class="label" for="k-usewhen">Use when</label>
			<input
				id="k-usewhen"
				class="input"
				maxlength="300"
				bind:value={draft.useWhen}
				placeholder="e.g. Use when someone asks what a Fellow pledges and for how long."
			/>
			<p class="mt-1 text-xs text-ink-soft">
				One sentence: Claude reads the entry when the task matches it.
			</p>
		</div>
		<div class="grid grid-cols-3 gap-3">
			<div>
				<label class="label" for="k-type">Type</label>
				<select id="k-type" class="input" bind:value={draft.type}>
					{#each types as t (t.id)}<option value={t.id}>{t.label}</option>{/each}
				</select>
				<p class="mt-1 text-xs text-ink-soft">{types.find((t) => t.id === draft.type)?.help}</p>
			</div>
			<div>
				<label class="label" for="k-audience">Audience</label>
				<select id="k-audience" class="input" bind:value={draft.audience}>
					{#each audiences as a (a.id)}<option value={a.id}>{a.label}</option>{/each}
				</select>
				<p class="mt-1 text-xs text-ink-soft">
					{audiences.find((a) => a.id === draft.audience)?.help}
				</p>
			</div>
			<div>
				<label class="label" for="k-review">Review every</label>
				<select id="k-review" class="input" bind:value={draft.reviewEvery}>
					{#each reviewEvery as m (m)}<option value={m}>{m} months</option>{/each}
				</select>
			</div>
		</div>
		<div class="grid grid-cols-2 gap-3">
			<div>
				<label class="label" for="k-use">How Claude uses it</label>
				<select id="k-use" class="input" bind:value={draft.use}>
					{#each uses as u (u.id)}<option value={u.id} disabled={u.id === 'always' && !approved}>
							{u.label}{u.id === 'always' && !approved ? ' (approve it first)' : ''}
						</option>{/each}
				</select>
				<p class="mt-1 text-xs text-ink-soft">{uses.find((u) => u.id === draft.use)?.help}</p>
			</div>
			<div>
				<label class="label" for="k-topics">
					Topics <span class="font-normal">(comma separated)</span>
				</label>
				<input
					id="k-topics"
					class="input"
					bind:value={draft.topics}
					placeholder="e.g. Pitch, Investors, Pledge"
				/>
			</div>
		</div>
		<div>
			<label class="label" for="k-expired">
				Expires <span class="font-normal">(optional: Claude stops using it after this day)</span>
			</label>
			<div class="flex items-center gap-3">
				<input id="k-expired" type="date" class="input w-44" bind:value={draft.expiredAt} />
				<button type="button" class="text-xs font-semibold text-primary-700" onclick={markExpired}>
					Mark as expired
				</button>
			</div>
		</div>
		<FormError message={error} />
	</div>
	{#snippet footer()}
		<button class="btn-ghost" onclick={() => (open = false)}>Cancel</button>
		<button class="btn-primary" disabled={saving} onclick={save}>
			<Save class="h-4 w-4" />
			{saving ? 'Saving…' : 'Save'}
		</button>
	{/snippet}
</Modal>
