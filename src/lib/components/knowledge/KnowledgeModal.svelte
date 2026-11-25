<script lang="ts">
	import Save from '@lucide/svelte/icons/save';
	import { callAction, errorText } from '$lib/actions';
	import type { KnowledgeEntry } from '$lib/types/knowledge';
	import Modal from '$lib/components/shared/Modal.svelte';
	import FormError from '$lib/components/shared/FormError.svelte';

	// Add or edit one entry. Owns its draft and the save call; the page's live listener shows the
	// result once the action returns. Ported from the EBS Hub's KnowledgeModal.
	let {
		open = $bindable(false),
		entry
	}: {
		open: boolean;
		/** The entry to edit, or null to add one. */
		entry: KnowledgeEntry | null;
	} = $props();

	let draft = $state({ label: '', description: '', expiredAt: '' });
	let saving = $state(false);
	let error = $state<string | null>(null);

	// Reset the draft each time the modal opens, for the entry it opens on.
	$effect(() => {
		if (open) {
			draft = {
				label: entry?.label ?? '',
				description: entry?.description ?? '',
				expiredAt: entry?.expiredAt ?? ''
			};
			error = null;
		}
	});

	/** Expiry set to yesterday: the entry is kept but no longer given to Claude. */
	function markExpired() {
		draft.expiredAt = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
	}

	async function save() {
		if (!draft.description.trim()) {
			error = 'Write the entry before saving.';
			return;
		}
		saving = true;
		error = null;
		try {
			await callAction('core:knowledge.save', {
				id: entry?.id ?? null,
				entry: {
					label: draft.label.trim(),
					description: draft.description.trim(),
					expiredAt: draft.expiredAt.trim()
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
				placeholder="e.g. Fellows pledge 1% of their future income to the Fellowship. It is not equity and starts only above the average salary."
			></textarea>
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
