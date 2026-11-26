<script lang="ts">
	import Save from '@lucide/svelte/icons/save';
	import { callAction, errorText } from '$lib/actions';
	import type { Skill, SkillDetail } from '$lib/types/skills';
	import Modal from '$lib/components/shared/Modal.svelte';
	import FormError from '$lib/components/shared/FormError.svelte';

	// Add or edit a skill written in the Hub: name, description and the Markdown body. Owns its
	// draft and the save call; the audit runs on save and shows in the list.
	let {
		open = $bindable(false),
		skill,
		limits,
		onsaved
	}: {
		open: boolean;
		/** The Hub skill to edit, or null to add one. */
		skill: Skill | null;
		limits: { maxName: number; maxDescription: number; maxBody: number };
		onsaved: () => void;
	} = $props();

	let draft = $state({ name: '', description: '', body: '' });
	/** The draft as it opened, to tell unsaved edits (Modal asks before closing). */
	let initial = $state('');
	let dirty = $derived(open && initial !== '' && JSON.stringify(draft) !== initial);
	let loading = $state(false);
	let saving = $state(false);
	let error = $state<string | null>(null);

	function reset(d: { name: string; description: string; body: string }) {
		draft = d;
		// From the plain object: reading `draft` here would rerun the effect on every keystroke.
		initial = JSON.stringify(d);
	}

	// Each time it opens: empty for a new skill, else the skill with its body (not in the list).
	$effect(() => {
		if (!open) return;
		error = null;
		initial = '';
		if (!skill) return reset({ name: '', description: '', body: '' });
		const id = skill.id;
		loading = true;
		callAction<SkillDetail>('core:skills.get', { id })
			.then((d) => {
				if (skill?.id === id) reset({ name: d.name, description: d.description, body: d.body });
			})
			.catch((e) => (error = errorText(e)))
			.finally(() => (loading = false));
	});

	let useWhen = $derived(
		!draft.description.trim() || /^use when\b/i.test(draft.description.trim())
	);

	async function save() {
		if (!draft.name.trim()) {
			error = 'Give the skill a name.';
			return;
		}
		saving = true;
		error = null;
		try {
			await callAction('core:skills.save', {
				id: skill?.id ?? null,
				name: draft.name.trim(),
				description: draft.description.trim(),
				body: draft.body
			});
			open = false;
			onsaved();
		} catch (e) {
			error = errorText(e);
		} finally {
			saving = false;
		}
	}
</script>

<Modal bind:open {dirty} title={skill ? 'Edit skill' : 'Add skill'} width="max-w-3xl">
	{#if loading}
		<p class="text-sm text-ink-soft">Loading…</p>
	{:else}
		<div class="space-y-3">
			<div>
				<label class="label" for="s-name">Name</label>
				<input
					id="s-name"
					class="input"
					maxlength={limits.maxName}
					bind:value={draft.name}
					placeholder="e.g. fellow-intro-email"
				/>
			</div>
			<div>
				<label class="label" for="s-description">Description</label>
				<textarea
					id="s-description"
					class="input"
					rows="2"
					maxlength={limits.maxDescription}
					bind:value={draft.description}
					placeholder="e.g. Use when writing a first email to a founder who applied to the Fellowship."
				></textarea>
				<p class="mt-1 text-xs {useWhen ? 'text-ink-soft' : 'text-warning'}">
					{useWhen
						? 'Start with “Use when …”: Claude picks the skill from this sentence.'
						: 'Claude picks a skill by its description: start it with “Use when …”.'}
					{draft.description.length}/{limits.maxDescription}
				</p>
			</div>
			<div>
				<label class="label" for="s-body">Instructions (Markdown)</label>
				<textarea
					id="s-body"
					class="input font-mono text-xs"
					rows="16"
					maxlength={limits.maxBody}
					bind:value={draft.body}
					placeholder="# Steps&#10;1. …"></textarea>
			</div>
			<FormError message={error} />
		</div>
	{/if}
	{#snippet footer()}
		<button class="btn-ghost" onclick={() => (open = false)}>Cancel</button>
		<button class="btn-primary" disabled={saving || loading} onclick={save}>
			<Save class="h-4 w-4" />
			{saving ? 'Saving…' : 'Save'}
		</button>
	{/snippet}
</Modal>
