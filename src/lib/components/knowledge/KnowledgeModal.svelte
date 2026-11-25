<script lang="ts">
	import Save from '@lucide/svelte/icons/save';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import { callAction, errorText } from '$lib/actions';
	import type { KnowledgeEntry, KnowledgeUseOption } from '$lib/types/knowledge';
	import Modal from '$lib/components/shared/Modal.svelte';
	import FormError from '$lib/components/shared/FormError.svelte';

	// Add or edit one entry. Owns its draft and the save call; the page's live listener shows the
	// result once the action returns. Ported from the EBS Hub's KnowledgeModal. An entry imported
	// from Drive keeps its title and text from Drive: here only how Claude uses it changes.
	let {
		open = $bindable(false),
		entry,
		uses
	}: {
		open: boolean;
		/** The entry to edit, or null to add one. */
		entry: KnowledgeEntry | null;
		uses: KnowledgeUseOption[];
	} = $props();

	let draft = $state({ label: '', description: '', expiredAt: '', use: 'always', topics: '' });
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
				use: entry?.use ?? 'always',
				topics: (entry?.topics ?? []).join(', ')
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
			await callAction('core:knowledge.save', {
				id: entry?.id ?? null,
				entry: imported
					? { expiredAt: draft.expiredAt.trim(), use: draft.use, topics }
					: {
							label: draft.label.trim(),
							description: draft.description.trim(),
							expiredAt: draft.expiredAt.trim(),
							use: draft.use,
							topics
						}
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
		<div class="grid grid-cols-2 gap-3">
			<div>
				<label class="label" for="k-use">How Claude uses it</label>
				<select id="k-use" class="input" bind:value={draft.use}>
					{#each uses as u (u.id)}<option value={u.id}>{u.label}</option>{/each}
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
