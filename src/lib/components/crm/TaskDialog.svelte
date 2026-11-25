<script lang="ts">
	import Trash from '@lucide/svelte/icons/trash-2';
	import { callAction, errorText } from '$lib/actions';
	import { toDate } from '$lib/utils';
	import type { Task, TeamUser } from '$lib/types/crm';
	import Modal from '$lib/components/shared/Modal.svelte';
	import FormError from '$lib/components/shared/FormError.svelte';

	// Edit a task's title, due date and assignee, or delete it. A portal task only takes a new
	// assignee: the sheet owns its title and date, and would bring a deleted one back.
	let {
		open = $bindable(false),
		task,
		team
	}: { open: boolean; task: Task | null; team: TeamUser[] } = $props();

	/** The local calendar day of a due date, as a date input wants it. */
	function day(value: unknown): string {
		const d = toDate(value);
		if (!d) return '';
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	}

	let title = $state('');
	let due = $state('');
	let assignee = $state('');
	let saving = $state(false);
	let error = $state<string | null>(null);
	let portal = $derived(task?.source === 'portal');

	// Fresh fields each time it opens.
	$effect(() => {
		if (!open || !task) return;
		title = task.title;
		due = day(task.dueAt);
		assignee = task.assigneeUid ?? '';
		error = null;
	});

	let dirty = $derived(
		!!task &&
			(title !== task.title || due !== day(task.dueAt) || assignee !== (task.assigneeUid ?? ''))
	);

	async function run(
		action: 'crm:task.update' | 'crm:task.delete',
		payload: Record<string, unknown>
	) {
		saving = true;
		error = null;
		try {
			await callAction(action, payload);
			open = false;
		} catch (e) {
			error = errorText(e);
		} finally {
			saving = false;
		}
	}

	function save() {
		if (!task) return;
		run(
			'crm:task.update',
			portal
				? { id: task.id, assigneeUid: assignee }
				: { id: task.id, title, dueAt: due, assigneeUid: assignee }
		);
	}

	function remove() {
		if (task && confirm(`Delete the task "${task.title}"? This cannot be undone.`))
			run('crm:task.delete', { id: task.id });
	}
</script>

<Modal bind:open title="Edit task" {dirty}>
	{#if task}
		<div class="space-y-3">
			<div>
				<label class="label" for="task-title">Task</label>
				<input id="task-title" class="input" bind:value={title} disabled={portal} />
			</div>
			<div class="grid grid-cols-2 gap-3">
				<div>
					<label class="label" for="task-due">Due</label>
					<input id="task-due" class="input" type="date" bind:value={due} disabled={portal} />
				</div>
				<div>
					<label class="label" for="task-for">For</label>
					<select id="task-for" class="input" bind:value={assignee}>
						<option value="">Nobody</option>
						{#each team as u (u.id)}<option value={u.id}>{u.name || u.email}</option>{/each}
					</select>
				</div>
			</div>
			{#if portal}
				<p class="text-xs text-ink-soft">
					Synced from the Portal: change its title and date in the sheet.
				</p>
			{/if}
			<FormError message={error} />
		</div>
	{/if}
	{#snippet footer()}
		{#if !portal}
			<button class="mr-auto btn-ghost text-danger" onclick={remove} disabled={saving}>
				<Trash class="h-4 w-4" /> Delete task
			</button>
		{/if}
		<button class="btn-ghost" onclick={() => (open = false)}>Cancel</button>
		<button class="btn-primary" onclick={save} disabled={saving || !title.trim()}>
			{saving ? 'Saving…' : 'Save'}
		</button>
	{/snippet}
</Modal>
