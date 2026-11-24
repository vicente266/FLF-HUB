<script lang="ts">
	import { collection, query, where, orderBy, limit } from 'firebase/firestore';
	import { db } from '$lib/firebase';
	import { callAction, errorText } from '$lib/actions';
	import { me } from '$lib/stores';
	import { hasPermission, listen, setTitle, formatDate, toDate } from '$lib/utils';
	import type { Task } from '$lib/types/crm';
	import FormError from '$lib/components/shared/FormError.svelte';
	import Empty from '$lib/components/shared/Empty.svelte';

	setTitle('Tasks', 'Follow-ups from you and from the automations');

	const canWrite = hasPermission('crm.any.write');
	let scope = $state<'mine' | 'all'>('mine');
	let tasks = $state<Task[]>([]);
	let error = $state<string | null>(null);

	$effect(() => {
		const base = collection(db, 'task');
		const q =
			scope === 'mine' && $me
				? query(
						base,
						where('assigneeUid', '==', $me.uid),
						where('done', '==', false),
						orderBy('dueAt'),
						limit(200)
					)
				: query(base, where('done', '==', false), orderBy('dueAt'), limit(200));
		return listen<Task>(q, (rows) => (tasks = rows));
	});

	const due = (t: Task) => toDate(t.dueAt)?.getTime() ?? 0;
	// Midnight tonight, local time.
	// Re-read every minute, so a page left open past midnight moves tasks to the right group.
	let now = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 60_000);
		return () => clearInterval(timer);
	});
	let endOfToday = $derived(new Date(new Date(now).toDateString()).getTime() + 86_400_000 - 1);
	let groups = $derived([
		{ label: 'Overdue', rows: tasks.filter((t) => due(t) < now), tone: 'text-danger' },
		{
			label: 'Today',
			rows: tasks.filter((t) => due(t) >= now && due(t) <= endOfToday),
			tone: 'text-primary-700'
		},
		{ label: 'Later', rows: tasks.filter((t) => due(t) > endOfToday), tone: 'text-ink-soft' }
	]);

	async function done(id: string) {
		try {
			await callAction('crm:task.done', { id, done: true });
		} catch (e) {
			error = errorText(e);
		}
	}
</script>

<div class="mx-auto max-w-4xl space-y-4">
	<div class="flex w-fit rounded-lg border border-line/70 bg-white p-0.5">
		{#each [['mine', 'Mine'], ['all', 'Everyone']] as [value, label] (value)}
			<button
				class="rounded-md px-3 py-1 text-sm font-semibold {scope === value
					? 'bg-primary-600 text-white'
					: 'text-ink-soft'}"
				onclick={() => (scope = value as 'mine' | 'all')}
			>
				{label}
			</button>
		{/each}
	</div>
	<FormError message={error} />

	{#if tasks.length === 0}
		<Empty title="No open tasks">
			Automations create follow-ups as contacts move through the pipeline.
		</Empty>
	{/if}

	{#each groups as g (g.label)}
		{#if g.rows.length}
			<section class="card">
				<div
					class="border-b border-line/60 px-4 py-2 text-xs font-bold tracking-wide uppercase {g.tone}"
				>
					{g.label} · {g.rows.length}
				</div>
				<ul class="divide-y divide-line/40">
					{#each g.rows as t (t.id)}
						<li class="flex items-center gap-3 px-4 py-2.5 text-sm">
							<input
								type="checkbox"
								class="rounded text-primary-600"
								disabled={!canWrite}
								onchange={() => done(t.id)}
							/>
							<div class="min-w-0 flex-1">
								<div class="font-medium">{t.title}</div>
								<a href="/crm/{t.contactId}" class="text-xs text-ink-soft hover:text-primary-700">
									{t.contactName}
								</a>
							</div>
							<span class="text-xs text-ink-soft">
								{t.source === 'automation' ? 'Automation' : 'Manual'}
							</span>
							<span class="w-24 text-right text-xs font-semibold {g.tone}">
								{formatDate(t.dueAt)}
							</span>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/each}
</div>
