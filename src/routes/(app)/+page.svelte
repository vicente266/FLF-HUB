<script lang="ts">
	import { onMount } from 'svelte';
	import { collection, query, where, orderBy, limit } from 'firebase/firestore';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { db } from '$lib/firebase';
	import { callAction } from '$lib/actions';
	import { me } from '$lib/stores';
	import { hasPermission, listen, setTitle, formatDate, toDate } from '$lib/utils';
	import type { Contact, Task } from '$lib/types/crm';
	import type { Health } from '$lib/types/connections';
	import StatusDot from '$lib/components/shared/StatusDot.svelte';

	setTitle('Home', 'What needs you today');

	interface Summary {
		kpis: { newLast30: number; needsAttention: number; openTasks: number; overdueTasks: number };
	}

	let tasks = $state<Task[]>([]);
	let attention = $state<Contact[]>([]);
	let summary = $state<Summary | null>(null);
	let health = $state<Health | null>(null);

	const canCrm = hasPermission('crm.any.read');

	onMount(() => {
		if (hasPermission('reports.any.read'))
			callAction<Summary>('reports:summary').then((s) => (summary = s));
		if (hasPermission('health.any.read'))
			callAction<Health>('connections:health.get').then((h) => (health = h));
		if (!canCrm || !$me) return;
		const unsubs = [
			listen<Task>(
				query(
					collection(db, 'task'),
					where('assigneeUid', '==', $me.uid),
					where('done', '==', false),
					orderBy('dueAt'),
					limit(20)
				),
				(rows) => (tasks = rows)
			),
			listen<Contact>(
				query(
					collection(db, 'contact'),
					where('needsAttention', '==', true),
					orderBy('createdAt', 'desc'),
					limit(10)
				),
				(rows) => (attention = rows)
			)
		];
		return () => unsubs.forEach((u) => u());
	});

	const overdue = (t: Task) => (toDate(t.dueAt)?.getTime() ?? 0) < Date.now();

	const HEALTH_TEXT = {
		ok: 'All systems working',
		warning: 'Some connections need setup',
		error: 'Something is failing',
		off: 'Off'
	};
</script>

<div class="mx-auto max-w-6xl space-y-6">
	<div>
		<p class="eyebrow">Welcome back</p>
		<h2 class="mt-1 text-2xl font-bold">
			Hello{$me?.name ? `, ${$me.name.split(' ')[0]}` : ''}. Keep the climb moving.
		</h2>
	</div>

	{#if summary}
		<div class="grid grid-cols-4 gap-3">
			{#each [['New contacts (30 days)', summary.kpis.newLast30], ['Need attention', summary.kpis.needsAttention], ['Open tasks', summary.kpis.openTasks], ['Overdue tasks', summary.kpis.overdueTasks]] as [label, value] (label)}
				<div class="card px-4 py-3">
					<div class="text-xs font-semibold text-ink-soft">{label}</div>
					<div class="mt-1 text-2xl font-bold">{value}</div>
				</div>
			{/each}
		</div>
	{/if}

	<div class="grid grid-cols-3 gap-4">
		<section class="col-span-2 card">
			<div class="flex items-center justify-between border-b border-line/60 px-4 py-3">
				<h3 class="font-bold">My tasks</h3>
				<a href="/tasks" class="text-xs font-semibold text-primary-600 hover:text-primary-700">
					All tasks
				</a>
			</div>
			{#if tasks.length === 0}
				<p class="px-4 py-6 text-sm text-ink-soft">Nothing due. Nice.</p>
			{:else}
				<ul class="divide-y divide-line/40">
					{#each tasks as t (t.id)}
						<li class="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
							<div class="min-w-0">
								<div class="truncate font-medium">{t.title}</div>
								<a href="/crm/{t.contactId}" class="text-xs text-ink-soft hover:text-primary-700">
									{t.contactName}
								</a>
							</div>
							<span
								class="shrink-0 text-xs font-semibold {overdue(t)
									? 'text-danger'
									: 'text-ink-soft'}"
							>
								{formatDate(t.dueAt)}
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<div class="space-y-4">
			{#if health}
				<a href="/health" class="block card px-4 py-3 hover:border-primary-300">
					<div class="text-xs font-semibold text-ink-soft">System health</div>
					<div class="mt-1.5">
						<StatusDot level={health.overall} label={HEALTH_TEXT[health.overall]} />
					</div>
				</a>
			{/if}
			<section class="card">
				<div class="flex items-center gap-2 border-b border-line/60 px-4 py-3">
					<TriangleAlert class="h-4 w-4 text-warning" />
					<h3 class="font-bold">Need attention</h3>
				</div>
				{#if attention.length === 0}
					<p class="px-4 py-6 text-sm text-ink-soft">Every contact is moving.</p>
				{:else}
					<ul class="divide-y divide-line/40">
						{#each attention as c (c.id)}
							<li class="px-4 py-2 text-sm">
								<a href="/crm/{c.id}" class="font-medium hover:text-primary-700">{c.name}</a>
								<div class="text-xs text-ink-soft">{c.ownerName ?? 'No owner'}</div>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		</div>
	</div>
</div>
