<script lang="ts">
	import Modal from '$lib/components/shared/Modal.svelte';
	import { reasonAsk } from '$lib/helpers/crmConfig.svelte';

	// Answers `askReason`: why a contact is moving to a losing stage (Lost, Declined).
	let text = $state('');
	let ask = $derived(reasonAsk.current);

	function answer(value: string | null) {
		const a = reasonAsk.current;
		if (!a) return;
		reasonAsk.current = null;
		text = '';
		a.resolve(value === null ? null : value.trim().slice(0, 500));
	}
</script>

<Modal
	bind:open={() => !!ask, (v) => !v && answer(null)}
	title={ask ? `Move to ${ask.stage}` : ''}
	dirty={!!text.trim()}
>
	{#if ask}
		<label class="label" for="lost-reason">
			Why is {ask.name}
			{ask.stage.toLowerCase()}? <span class="font-normal text-ink-soft">Optional</span>
		</label>
		<textarea
			id="lost-reason"
			class="input"
			rows="3"
			maxlength="500"
			placeholder="Kept on the contact and its timeline"
			bind:value={text}></textarea>
	{/if}
	{#snippet footer()}
		<button class="btn-ghost" onclick={() => answer(null)}>Cancel</button>
		<button class="btn-primary" onclick={() => answer(text)}>Move to {ask?.stage}</button>
	{/snippet}
</Modal>
