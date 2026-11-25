<script lang="ts">
	import { collection, query, where, orderBy, limit } from 'firebase/firestore';
	import { tick } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import Pencil from '@lucide/svelte/icons/pencil';
	import { db } from '$lib/firebase';
	import { me } from '$lib/stores';
	import { hasPermission, listen, setTitle, formatDate, toDate } from '$lib/utils';
	import { tickTask } from '$lib/helpers/crmConfig.svelte';
	import type { Task, TeamUser } from '$lib/types/crm';
	import FormError from '$lib/components/shared/FormError.svelte';
	import Empty from '$lib/components/shared/Empty.svelte';
	import TaskDialog from '$lib/components/crm/TaskDialog.svelte';

	setTitle('Tasks', 'Follow-ups from you and from the automations');

	const canWrite = hasPermission('crm.any.write');
	const SOURCE: Record<string, string> = {
		automation: 'Auto-created',
		claude: 'Via Claude',
		portal: 'Portal',
		manual: 'Manual'
	};
	// ?scope=all opens Everyone (Home links here); #overdue scrolls to the Overdue group.
	let scope = $state<'mine' | 'all'>(page.url.searchParams.get('scope') === 'all' ? 'all' : 'mine');
	let tasks = $state<Task[]>([]);
	let loaded = $state(false);
	let error = $state<string | null>(null);
	function setScope(value: 'mine' | 'all') {
		scope = value;
		goto(`/tasks?scope=${value}`, { replaceState: true, keepFocus: true, noScroll: true });
	}

	// Names for "Everyone" and the edit dialog's "For".
	let team = $state<TeamUser[]>([]);
	$effect(() =>
		listen<TeamUser>(
			query(collection(db, 'user'), where('role', 'in', ['user', 'admin']), limit(200)),
			(rows) => (team = rows)
		)
	);
	const nameOf = (uid: string | null) => {
		const u = uid ? team.find((x) => x.id === uid) : null;
		return u ? u.name || u.email : null;
	};
	let editing = $state<Task | null>(null);
	let editOpen = $state(false);

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
		return listen<Task>(q, (rows) => {
			tasks = rows;
			loaded = true;
		});
	});

	// Once the list is in, scroll to the group the link named.
	let scrolled = false;
	$effect(() => {
		if (!loaded || scrolled || !page.url.hash) return;
		scrolled = true;
		tick().then(() => document.getElementById(page.url.hash.slice(1))?.scrollIntoView());
	});

	// No due date: its own group, never Overdue.
	const due = (t: Task) => toDate(t.dueAt)?.getTime() ?? null;
	const dated = (t: Task, test: (ms: number) => boolean) => {
		const ms = due(t);
		return ms !== null && test(ms);
	};
	// Midnight tonight, local time.
	// Re-read every minute, so a page left open past midnight moves tasks to the right group.
	let now = $state(Date.now());
	$effect(() => {
		const timer = setInterval(() => (now = Date.now()), 60_000);
		return () => clearInterval(timer);
	});
	let endOfToday = $derived(new Date(new Date(now).toDateString()).getTime() + 86_400_000 - 1);
	// Sunday night, local time (the week runs Monday to Sunday).
	let endOfWeek = $derived(endOfToday + ((7 - new Date(now).getDay()) % 7) * 86_400_000);
	let groups = $derived([
		{ label: 'Overdue', rows: tasks.filter((t) => dated(t, (d) => d < now)), tone: 'text-danger' },
		{
			label: 'Today',
			rows: tasks.filter((t) => dated(t, (d) => d >= now && d <= endOfToday)),
			tone: 'text-primary-700'
		},
		{
			label: 'This week',
			rows: tasks.filter((t) => dated(t, (d) => d > endOfToday && d <= endOfWeek)),
			tone: 'text-ink'
		},
		{
			label: 'Later',
			rows: tasks.filter((t) => dated(t, (d) => d > endOfWeek)),
			tone: 'text-ink-soft'
		},
		{ label: 'No due date', rows: tasks.filter((t) => due(t) === null), tone: 'text-ink-soft' }
	]);

	async function done(id: string, box: HTMLInputElement) {
		error = await tickTask(id, box);
	}
</script>

<div class="mx-auto max-w-4xl space-y-4">
	<div class="flex w-fit rounded-lg border border-line/70 bg-white p-0.5">
		{#each [['mine', 'Mine'], ['all', 'Everyone']] as [value, label] (value)}
			<button
				class="rounded-md px-3 py-1 text-sm font-semibold {scope === value
					? 'bg-primary-600 text-white'
					: 'text-ink-soft'}"
				onclick={() => setScope(value as 'mine' | 'all')}
			>
				{label}
			</button>
		{/each}
	</div>
	<FormError message={error} />

	{#if loaded && tasks.length === 0}
		<Empty title="No open tasks">
			Automations create follow-ups as contacts move through the pipeline. You can also add one from
			any contact's page.
		</Empty>
	{/if}

	{#each groups as g (g.label)}
		{#if g.rows.length}
			<section class="scroll-mt-4 card" id={g.label.toLowerCase().replaceAll(' ', '-')}>
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
								checked={false}
								onchange={(e) => done(t.id, e.currentTarget)}
							/>
							<div class="min-w-0 flex-1">
								<div class="font-medium">{t.title}</div>
								{#if t.contactId}
									<a href="/crm/{t.contactId}" class="text-xs text-ink-soft hover:text-primary-700">
										{t.contactName}
									</a>
								{:else if t.ownerName}
									<span class="text-xs text-ink-soft">{t.ownerName} · from the portal</span>
								{/if}
							</div>
							<span class="text-right text-xs text-ink-soft">
								{#if scope === 'all'}
									<span class="font-semibold text-ink">
										{nameOf(t.assigneeUid) ?? 'Unassigned'}
									</span><br />
								{/if}
								{SOURCE[t.source] ?? 'Manual'}
							</span>
							<span class="w-24 text-right text-xs font-semibold {g.tone}">
								{formatDate(t.dueAt)}
							</span>
							{#if canWrite}
								<button
									class="p-1 text-ink-soft hover:text-ink"
									aria-label="Edit task"
									title="Edit task"
									onclick={() => {
										editing = t;
										editOpen = true;
									}}
								>
									<Pencil class="h-3.5 w-3.5" />
								</button>
							{/if}
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/each}
</div>

<TaskDialog bind:open={editOpen} task={editing} {team} />
