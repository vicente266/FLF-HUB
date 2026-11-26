<script lang="ts">
	import { onMount } from 'svelte';
	import {
		collection,
		query,
		where,
		orderBy,
		limit,
		getCountFromServer,
		Timestamp
	} from 'firebase/firestore';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { db } from '$lib/firebase';
	import { callAction, errorText } from '$lib/actions';
	import { me } from '$lib/stores';
	import { hasPermission, listen, setTitle, formatDate, formatDateTime, toDate } from '$lib/utils';
	import {
		contactTitle,
		crmConfig,
		daysQuiet,
		stageLabel,
		tickTask
	} from '$lib/helpers/crmConfig.svelte';
	import type { Contact, Task } from '$lib/types/crm';
	import type { Health } from '$lib/types/connections';
	import StatusDot from '$lib/components/shared/StatusDot.svelte';
	import FormError from '$lib/components/shared/FormError.svelte';

	setTitle('Home', 'What needs you today');

	interface Summary {
		kpis: {
			newLast30: number;
			/** Open, no activity for staleDays: the team's, the caller's, and with no owner. */
			attentionTeam: number;
			attentionMine: number;
			attentionNoOwner: number;
			openTasks: number;
			overdueTasks: number;
		};
	}

	let tasks = $state<Task[]>([]);
	let undated = $state(0);
	let stale = $state<Contact[]>([]);
	// The team's longest-quiet first, yours on top (all of yours: the card above links there).
	let attention = $derived([
		...stale.filter((c) => c.ownerUid === $me?.uid),
		...stale.filter((c) => c.ownerUid !== $me?.uid)
	]);
	let error = $state<string | null>(null);
	const cfg = crmConfig();
	let summary = $state<Summary | null>(null);
	let health = $state<Health | null>(null);

	const canCrm = hasPermission('crm.any.read');
	const canWrite = hasPermission('crm.any.write');

	// Needs attention, live: open and no activity for staleDays (the CRM uses the same rule).
	$effect(() => {
		const staleDays = cfg.value?.staleDays;
		const uid = $me?.uid;
		if (!canCrm || !uid || !staleDays) return;
		const cutoff = Timestamp.fromMillis(Date.now() - staleDays * 86_400_000);
		return listen<Contact>(
			query(
				collection(db, 'contact'),
				where('open', '==', true),
				where('lastActivityAt', '<', cutoff),
				orderBy('lastActivityAt'),
				limit(10)
			),
			(rows) => (stale = rows)
		);
	});

	const canReports = hasPermission('reports.any.read');
	function loadKpis() {
		if (!canReports) return;
		callAction<Summary>('reports:kpis')
			.then((s) => (summary = s))
			.catch((e) => (error = errorText(e)));
	}

	onMount(() => {
		loadKpis();
		if (hasPermission('health.any.read'))
			callAction<Health>('connections:health.get')
				.then((h) => (health = h))
				.catch((e) => (error = errorText(e)));
		if (!canCrm || !$me) return;
		const mine = [where('assigneeUid', '==', $me.uid), where('done', '==', false)];
		// Undated tasks (mostly from the portal sheet) are counted apart, so they can't push the
		// overdue ones out of the list.
		getCountFromServer(query(collection(db, 'task'), ...mine, where('dueAt', '==', null)))
			.then((r) => (undated = r.data().count))
			.catch(() => {});
		const unsubs = [
			listen<Task>(
				query(
					collection(db, 'task'),
					...mine,
					where('dueAt', '!=', null),
					orderBy('dueAt'),
					limit(20)
				),
				(rows) => (tasks = rows)
			)
		];
		return () => unsubs.forEach((u) => u());
	});

	// A task with no due date is never overdue.
	const overdue = (t: Task) => (toDate(t.dueAt)?.getTime() ?? Infinity) < Date.now();

	const HEALTH_TEXT = {
		ok: 'All systems working',
		warning: 'Working, some connections need setup',
		error: 'Something is failing',
		off: 'Nothing switched on'
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
		{@const k = summary.kpis}
		<div class="grid grid-cols-2 gap-3 md:grid-cols-4">
			{#each [{ label: 'My open tasks', value: k.openTasks, href: '/tasks?scope=mine', tone: '' }, { label: 'My overdue tasks', value: k.overdueTasks, href: '/tasks?scope=mine#overdue', tone: k.overdueTasks ? 'text-danger' : '' }, { label: 'My contacts needing attention', value: k.attentionMine, href: '/crm?type=all&attention=1&owner=me', tone: k.attentionMine ? 'text-warning' : '' }, { label: 'New contacts (30 days, team)', value: k.newLast30, href: '/crm?type=all&since=30', tone: '' }] as { label, value, href, tone } (label)}
				<a {href} class="block card px-4 py-3 hover:border-primary-300">
					<div class="text-xs font-semibold text-ink-soft">{label}</div>
					<div class="mt-1 text-2xl font-bold {tone}">{value}</div>
				</a>
			{/each}
		</div>
	{/if}
	<FormError message={error} />

	<div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
		<section class="card lg:col-span-2">
			<div class="flex items-center justify-between border-b border-line/60 px-4 py-3">
				<h3 class="font-bold">My tasks</h3>
				<a
					href="/tasks?scope=mine"
					class="text-xs font-semibold text-primary-600 hover:text-primary-700"
				>
					All tasks
				</a>
			</div>
			{#if tasks.length === 0 && !undated}
				<p class="px-4 py-6 text-sm text-ink-soft">No open tasks. Nice.</p>
			{:else if tasks.length === 0}
				<p class="px-4 py-6 text-sm text-ink-soft">No dated tasks.</p>
			{:else}
				<ul class="divide-y divide-line/40">
					{#each tasks as t (t.id)}
						<li class="flex items-center gap-3 px-4 py-2.5 text-sm">
							<input
								type="checkbox"
								class="rounded text-primary-600"
								aria-label="Done: {t.title}"
								disabled={!canWrite}
								checked={false}
								onchange={async (e) => {
									error = await tickTask(t.id, e.currentTarget);
									// The counts above changed with it.
									if (!error) loadKpis();
								}}
							/>
							<div class="min-w-0 flex-1">
								<div class="truncate font-medium">{t.title}</div>
								{#if t.contactId}
									<a href="/crm/{t.contactId}" class="text-xs text-ink-soft hover:text-primary-700">
										{t.contactName}
									</a>
								{:else if t.source === 'portal'}
									<span class="text-xs text-ink-soft">From the portal</span>
								{/if}
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
			{#if undated}
				<a
					href="/tasks?scope=mine#no-due-date"
					class="block border-t border-line/40 px-4 py-2 text-xs font-semibold text-primary-700 hover:underline"
				>
					+ {undated} with no due date
				</a>
			{/if}
		</section>

		<div class="min-w-0 space-y-4">
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
					<h3 class="font-bold">Needs attention</h3>
					{#if summary}
						{@const k = summary.kpis}
						<!-- The team's total, then yours and no owner: each opens the CRM filtered that way. -->
						<div class="ml-auto text-xs whitespace-nowrap text-ink-soft">
							<a
								href="/crm?type=all&attention=1"
								class="text-sm font-bold text-ink hover:text-primary-700"
								title="Open contacts with no activity for {cfg.value?.staleDays ?? 14} days"
							>
								{k.attentionTeam}
							</a>
							·
							<a href="/crm?type=all&attention=1&owner=me" class="hover:text-primary-700">
								yours {k.attentionMine}
							</a>
							·
							<a href="/crm?type=all&attention=1&owner=none" class="hover:text-primary-700">
								no owner {k.attentionNoOwner}
							</a>
						</div>
					{/if}
				</div>
				{#if attention.length === 0}
					<p class="px-4 py-6 text-sm text-ink-soft">
						No open contact has gone {cfg.value?.staleDays ?? 14} days without activity.
					</p>
				{:else}
					<ul class="divide-y divide-line/40">
						{#each attention as c (c.id)}
							<li class="px-4 py-2 text-sm">
								<a href="/crm/{c.id}" class="font-medium hover:text-primary-700">
									{contactTitle(c)}
								</a>
								<div class="text-xs text-ink-soft">
									<span
										class="font-semibold text-warning"
										title="Last activity {formatDateTime(c.lastActivityAt)}"
									>
										{daysQuiet(c)} days without activity
									</span>
									· {stageLabel(cfg.value, c.type, c.stage)} · {c.ownerUid === $me?.uid
										? 'Yours'
										: (c.ownerName ?? 'No owner')}
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		</div>
	</div>
</div>
