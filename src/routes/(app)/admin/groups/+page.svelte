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
	import { loadPermissions, type PermissionInfo } from './permissions';

	setTitle('Groups', 'Sets of permissions. A user can do everything any of their groups allows.');

	let groups = $state<Group[]>([]);
	let catalog = $state<PermissionInfo[]>([]);
	/** The permissions grouped by app, in the backend's order. */
	let byApp = $derived(
		[...new Set(catalog.map((p) => p.app))].map((app) => ({
			app,
			items: catalog.filter((p) => p.app === app)
		}))
	);
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
		loadPermissions()
			.then((c) => (catalog = c))
			.catch((e) => (error = errorText(e)));
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
		initial = snapshot(draft);
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

	/** A permission's label, or its id when the backend doesn't know it any more. */
	const labelOf = (id: string) => catalog.find((p) => p.id === id)?.label ?? id;
	/** Unsaved edits in the dialog (it asks before closing). */
	const snapshot = (d: typeof draft) =>
		JSON.stringify({
			name: d.name,
			description: d.description,
			permissions: [...d.permissions].sort()
		});
	/** The dialog as it opened, to tell unsaved edits (it asks before closing). */
	let initial = $state('');
	let dirty = $derived(editing && snapshot(draft) !== initial);
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
							{labelOf(p)}
						</span>{/each}
				</div>
			</button>
		{/each}
	</div>
</div>

<Modal bind:open={editing} {dirty} title={draft.id ? 'Edit group' : 'New group'} width="max-w-2xl">
	<div class="space-y-3">
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
			<div class="max-h-[55vh] space-y-3 overflow-y-auto pr-1">
				{#each byApp as g (g.app)}
					<fieldset>
						<legend class="text-xs font-bold text-ink">{g.app}</legend>
						<div class="mt-1 space-y-1">
							{#each g.items as p (p.id)}
								<label class="flex items-start gap-2 text-sm">
									<input
										type="checkbox"
										class="mt-0.5 rounded text-primary-600"
										value={p.id}
										bind:group={draft.permissions}
									/>
									<span class="min-w-0">
										<span class="font-medium">{p.label}</span>
										{#if p.adminsNeedIt}<span
												class="ml-1 rounded bg-warning/10 px-1.5 py-0.5 text-[11px] font-semibold text-warning"
											>
												Admins need this too
											</span>{/if}
										{#if p.help}<span class="block text-xs text-ink-soft">{p.help}</span>{/if}
									</span>
								</label>
							{/each}
						</div>
					</fieldset>
				{/each}
			</div>
		</div>
		<FormError message={error} />
	</div>
	{#snippet footer()}
		{#if draft.id}<button class="mr-auto btn-ghost text-danger" onclick={remove}>
				Delete
			</button>{/if}
		<button class="btn-ghost" onclick={() => (editing = false)}>Cancel</button>
		<button class="btn-primary" onclick={save} disabled={!draft.name.trim()}>Save</button>
	{/snippet}
</Modal>
