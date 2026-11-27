<script lang="ts">
	import { collection, query, where, limit } from 'firebase/firestore';
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { db } from '$lib/firebase';
	import { callAction, errorText } from '$lib/actions';
	import { me } from '$lib/stores';
	import { listen } from '$lib/utils';
	import type { ContactDraft, ContactType, CrmConfig, TeamUser } from '$lib/types/crm';
	import Modal from '$lib/components/shared/Modal.svelte';
	import FormError from '$lib/components/shared/FormError.svelte';
	import ContactForm from './ContactForm.svelte';

	// New contact, from the CRM (its current tab) or from a go-to-market strategy (a Partner in it).
	// Starts in the type's first stage, owned by me; opens the new contact once made.
	let {
		open = $bindable(false),
		config,
		type,
		strategyId = '',
		segment = ''
	}: {
		open: boolean;
		config: CrmConfig;
		type: ContactType;
		strategyId?: string;
		/** A Partner added from a strategy starts with that strategy's segment. */
		segment?: string;
	} = $props();

	const blank = (): ContactDraft => ({
		type,
		name: '',
		email: '',
		phone: '',
		company: '',
		linkedin: '',
		source: 'manual',
		tags: '',
		notes: '',
		segment,
		strategyId,
		stage: config.pipelines[type]?.stages[0]?.id ?? '',
		ownerUid: $me?.uid ?? ''
	});
	let draft = $state<ContactDraft>(blank());
	let pristine = $state(JSON.stringify(blank()));
	let saving = $state(false);
	let error = $state<string | null>(null);
	let team = $state<TeamUser[]>([]);

	$effect(() => {
		if (!open) return;
		// Only opening resets the form, not each keystroke.
		untrack(() => {
			draft = blank();
			pristine = JSON.stringify(draft);
			error = null;
		});
		return listen<TeamUser>(
			query(collection(db, 'user'), where('role', 'in', ['user', 'admin']), limit(200)),
			(rows) => (team = rows)
		);
	});

	let named = $derived(draft.type === 'partner' ? draft.company.trim() : draft.name.trim());

	async function create() {
		saving = true;
		error = null;
		try {
			const res = await callAction<{ id: string }>('crm:contact.create', {
				...draft,
				tags: draft.tags.split(',')
			});
			open = false;
			goto(`/crm/${res.id}`);
		} catch (e) {
			error = errorText(e);
		} finally {
			saving = false;
		}
	}
</script>

<Modal bind:open title="New contact" dirty={JSON.stringify(draft) !== pristine}>
	<div class="space-y-3">
		<ContactForm bind:draft {config} {team} creating />
		<FormError message={error} />
	</div>
	{#snippet footer()}
		<button class="btn-ghost" onclick={() => (open = false)}>Cancel</button>
		<button class="btn-primary" onclick={create} disabled={saving || !named}>
			{saving ? 'Creating…' : 'Create contact'}
		</button>
	{/snippet}
</Modal>
