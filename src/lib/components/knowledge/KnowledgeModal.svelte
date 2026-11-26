<script lang="ts">
	import Save from '@lucide/svelte/icons/save';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import { callAction, errorText } from '$lib/actions';
	import type { KnowledgeEntry, KnowledgeOption, KnowledgeUseOption } from '$lib/types/knowledge';
	import { isExpired } from '$lib/components/knowledge/expiry';
	import { wordCount, wordsOf } from '$lib/components/knowledge/words';
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
		reviewEvery,
		alwaysWords,
		alwaysBudget
	}: {
		open: boolean;
		/** The entry to edit, or null to add one. */
		entry: KnowledgeEntry | null;
		uses: KnowledgeUseOption[];
		types: KnowledgeOption[];
		audiences: KnowledgeOption[];
		reviewEvery: number[];
		/** Words of Always text now, and the most there should be (ALWAYS_BUDGET_WORDS). */
		alwaysWords: number;
		alwaysBudget: number;
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
		reviewEvery: 6,
		status: 'draft' as 'draft' | 'approved'
	});
	/** The draft as it opened, to tell unsaved edits (Modal asks before closing). */
	let initial = $state('');
	let dirty = $derived(open && initial !== '' && JSON.stringify(draft) !== initial);
	let imported = $derived(entry?.source === 'drive');
	let wasApproved = $derived(entry?.status === 'approved');
	let approved = $derived(draft.status === 'approved');
	/**
	 * Saving an approved entry with a new text, title or type sends it back to draft (the backend
	 * does it, docs/knowledge.md "The card").
	 */
	let backToDraft = $derived(
		wasApproved &&
			approved &&
			((!imported &&
				(draft.label.trim() !== (entry?.label ?? '') ||
					draft.description.trim() !== (entry?.description ?? '').trim())) ||
				draft.type !== (entry?.type ?? 'other') ||
				// Made shareable outside FLF: approved again too (as the backend does).
				(draft.audience === 'external' && (entry?.audience ?? 'internal') !== 'external'))
	);
	/** Always words once saved: this entry's (new) length in place of what it counts now. */
	let alwaysAfter = $derived.by(() => {
		if (draft.use !== 'always' || !alwaysBudget) return 0;
		const counted =
			entry && entry.use === 'always' && entry.status === 'approved' && !isExpired(entry)
				? wordsOf(entry)
				: 0;
		const mine = imported && entry ? wordsOf(entry) : wordCount(draft.description);
		return alwaysWords - counted + mine;
	});
	let saving = $state(false);
	let error = $state<string | null>(null);

	// Reset the draft each time the modal opens, for the entry it opens on.
	$effect(() => {
		if (open) {
			const d = {
				label: entry?.label ?? '',
				description: entry?.description ?? '',
				expiredAt: entry?.expiredAt ?? '',
				use: entry?.use ?? 'relevant',
				topics: (entry?.topics ?? []).join(', '),
				type: entry?.type ?? 'other',
				useWhen: entry?.useWhen ?? '',
				audience: entry?.audience ?? 'internal',
				reviewEvery: entry?.reviewEvery ?? 6,
				status: entry?.status ?? 'draft'
			};
			draft = d;
			// From the plain object: reading `draft` here would rerun this on every keystroke.
			initial = JSON.stringify(d);
			error = null;
		}
	});

	/** Only an approved entry can be Always: back to draft, Claude reads it when relevant. */
	function setStatus(status: 'draft' | 'approved') {
		draft.status = status;
		if (status === 'draft' && draft.use === 'always') draft.use = 'relevant';
	}

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
				reviewEvery: Number(draft.reviewEvery),
				// The row's Approve sends the same: the backend stamps who approved and when.
				status: draft.status
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

<Modal bind:open {dirty} title={entry ? 'Edit entry' : 'Add entry'} width="max-w-2xl">
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
				<label class="label" for="k-label">Title <span class="font-normal">(optional)</span></label>
				<input
					id="k-label"
					class="input"
					maxlength="80"
					bind:value={draft.label}
					placeholder="e.g. The Founder's Pledge"
				/>
			</div>
			<div>
				<label class="label" for="k-description">Text</label>
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
		<div class="grid grid-cols-4 gap-3">
			<div>
				<label class="label" for="k-status">Status</label>
				<select
					id="k-status"
					class="input"
					value={draft.status}
					onchange={(e) => setStatus(e.currentTarget.value as 'draft' | 'approved')}
				>
					<option value="draft">Draft</option>
					<option value="approved">Approved</option>
				</select>
				<p class="mt-1 text-xs text-ink-soft">
					{#if approved && !wasApproved}Approving here is the same as Approve on its row.{:else if approved}Approved{entry?.approvedBy
							? ` by ${entry.approvedBy}`
							: ''}.{:else}Claude says so when it relies on a draft.{/if}
				</p>
			</div>
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
		{#if alwaysAfter > alwaysBudget}
			<p class="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm" role="status">
				Always would come to {alwaysAfter.toLocaleString('en')} words, over the
				{alwaysBudget.toLocaleString('en')} Claude should read every time. Keep long documents When relevant:
				Claude reads the index and opens the sections it needs.
			</p>
		{/if}
		{#if backToDraft}
			<p class="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm" role="status">
				Saving sends this back to draft until you approve it again{draft.use === 'always'
					? ': Claude stops reading it Always meanwhile'
					: ''}.
			</p>
		{/if}
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
