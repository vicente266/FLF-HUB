<script lang="ts">
	import { onMount } from 'svelte';
	import { collection, query, orderBy } from 'firebase/firestore';
	import Plus from '@lucide/svelte/icons/plus';
	import { db } from '$lib/firebase';
	import { callAction, errorText } from '$lib/actions';
	import { listen, setTitle } from '$lib/utils';
	import type { Group } from '$lib/types/crm';
	import Modal from '$lib/components/shared/Modal.svelte';
	import FormError from '$lib/components/shared/FormError.svelte';

	setTitle('Groups', 'Sets of permissions. A user can do everything any of their groups allows.');

	let groups = $state<Group[]>([]);
	let permissions = $state<string[]>([]);
	let error = $state<string | null>(null);
	let editing = $state(false);
	let draft = $state<{
		id: string | null;
		name: string;
		description: string;
		permissions: string[];
	}>({
		id: null,
		name: '',
		description: '',
		permissions: []
	});

	onMount(() => {
		callAction<{ permissions: string[] }>('core:config.get').then(
			(r) => (permissions = r.permissions)
		);
		return listen<Group>(query(collection(db, 'group'), orderBy('name')), (r) => (groups = r));
	});

	function edit(g?: Group) {
		draft = g
			? {
					id: g.id,
					name: g.name,
					description: g.description ?? '',
					permissions: [...g.permissions]
				}
			: { id: null, name: '', description: '', permissions: [] };
		error = null;
		editing = true;
	}

	async function save() {
		try {
			await callAction('core:group.save', draft);
			editing = false;
		} catch (e) {
			error = errorText(e);
		}
	}

	async function remove() {
		if (
			!draft.id ||
			!confirm(`Delete the group ${draft.name}? Its members lose the permissions it gives.`)
		)
			return;
		try {
			await callAction('core:group.remove', { id: draft.id });
			editing = false;
		} catch (e) {
			error = errorText(e);
		}
	}

	/** `crm.any.write` → `CRM — Write` */
	function pretty(p: string) {
		const [feature, , ...rest] = p.split('.');
		return `${feature.toUpperCase() === 'CRM' ? 'CRM' : feature[0].toUpperCase() + feature.slice(1)} — ${rest.join(' ')}`;
	}
</script>

<div class="mx-auto max-w-4xl space-y-3">
	<div class="flex justify-end">
		<button class="btn-primary" onclick={() => edit()}><Plus class="h-4 w-4" /> New group</button>
	</div>
	<div class="grid grid-cols-2 gap-3">
		{#each groups as g (g.id)}
			<button class="card px-4 py-3 text-left hover:border-primary-300" onclick={() => edit(g)}>
				<div class="font-bold">{g.name}</div>
				{#if g.description}<div class="text-xs text-ink-soft">{g.description}</div>{/if}
				<div class="mt-2 flex flex-wrap gap-1">
					{#each g.permissions as p (p)}<span
							class="rounded bg-primary-50 px-1.5 py-0.5 text-[11px] text-primary-700"
						>
							{pretty(p)}
						</span>{/each}
				</div>
			</button>
		{/each}
	</div>
</div>

<Modal bind:open={editing} title={draft.id ? 'Edit group' : 'New group'}>
	<div class="space-y-3">
		<FormError message={error} />
		<div>
			<label class="label" for="gname">Name</label>
			<input id="gname" class="input" bind:value={draft.name} />
		</div>
		<div>
			<label class="label" for="gdesc">Description</label>
			<input id="gdesc" class="input" bind:value={draft.description} />
		</div>
		<div>
			<div class="label">Permissions</div>
			<div class="grid grid-cols-2 gap-1">
				{#each permissions as p (p)}
					<label class="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							class="rounded text-primary-600"
							value={p}
							bind:group={draft.permissions}
						/>
						{pretty(p)}
					</label>
				{/each}
			</div>
		</div>
	</div>
	{#snippet footer()}
		{#if draft.id}<button class="mr-auto btn-ghost text-danger" onclick={remove}>
				Delete
			</button>{/if}
		<button class="btn-ghost" onclick={() => (editing = false)}>Cancel</button>
		<button class="btn-primary" onclick={save} disabled={!draft.name.trim()}>Save</button>
	{/snippet}
</Modal>
