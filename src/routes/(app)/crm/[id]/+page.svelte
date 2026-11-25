<script lang="ts">
	import { collection, doc, query, where, orderBy, limit } from 'firebase/firestore';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash from '@lucide/svelte/icons/trash-2';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import IdCard from '@lucide/svelte/icons/id-card';
	import FellowProfile from '$lib/components/crm/FellowProfile.svelte';
	import { db } from '$lib/firebase';
	import { callAction, errorText } from '$lib/actions';
	import {
		hasPermission,
		listen,
		listenDoc,
		setTitle,
		formatDate,
		formatDateTime,
		toDate
	} from '$lib/utils';
	import {
		contactSubtitle,
		askReason,
		contactTitle,
		crmConfig,
		typeStyle
	} from '$lib/helpers/crmConfig.svelte';
	import type { Activity, Contact, ContactDraft, Strategy, Task, TeamUser } from '$lib/types/crm';
	import Modal from '$lib/components/shared/Modal.svelte';
	import FormError from '$lib/components/shared/FormError.svelte';
	import ContactForm from '$lib/components/crm/ContactForm.svelte';

	const cfg = crmConfig();
	const canWrite = hasPermission('crm.any.write');
	const canDelete = hasPermission('crm.any.delete');
	const canWellbeing = hasPermission('wellbeing.any.read');
	const canWealth = hasPermission('wealth.any.read');

	interface Perma {
		completedAt: number | null;
		scores: Record<string, number | null>;
	}
	interface Finance {
		startingIncome?: number | null;
		currentIncome?: number | null;
		growth?: string;
		reports?: Record<string, Record<string, { gross: number; net: number; value: number }>>;
		syncedAt?: number | null;
	}
	let perma = $state<Perma[] | null>(null);
	let money = $state<Finance | null>(null);
	const PERMA_KEYS = ['P', 'E', 'R', 'M', 'A', 'N', 'H', 'Loneliness', 'Happiness', 'Overall'];
	const PERMA_LABEL: Record<string, string> = { Loneliness: 'Lonely', Happiness: 'Happy' };
	function pledge(p: NonNullable<Contact['portal']>): string | null {
		if (p.pledgeSigned === null) return null;
		return p.pledgeSigned ? `Signed ${formatDate(p.pledgeDate)}` : 'Not signed';
	}
	const eur = (n: number | null | undefined) =>
		typeof n === 'number' ? `€${Math.round(n).toLocaleString('en-GB')}` : '—';

	// Restricted data: fetched through their own actions, only for those who may see it.
	$effect(() => {
		const cid = id;
		// A slower answer for the previous contact must not land on this one.
		let alive = true;
		perma = null;
		money = null;
		if (canWellbeing)
			callAction<Perma[]>('portal:wellbeing.get', { contactId: cid })
				.then((r) => alive && (perma = r))
				.catch(() => {});
		if (canWealth)
			callAction<Finance | null>('portal:finance.get', { contactId: cid })
				.then((r) => alive && (money = r))
				.catch(() => {});
		return () => {
			alive = false;
		};
	});

	let id = $derived(page.params.id ?? '');
	let contact = $state<Contact | null | undefined>(undefined);
	let activity = $state<Activity[]>([]);
	let tasks = $state<Task[]>([]);
	let closedTasks = $state<Task[]>([]);
	let showClosed = $state(false);
	let team = $state<TeamUser[]>([]);
	let error = $state<string | null>(null);
	let profileOpen = $state(false);

	// A Partner's go-to-market strategy, for its name and link.
	let strategy = $state<Strategy | null>(null);
	// Derived, so the listener only restarts when the strategy itself changes, not on every edit.
	let strategyId = $derived(contact?.strategyId ?? '');
	$effect(() => {
		const sid = strategyId;
		strategy = null;
		if (!sid) return;
		return listenDoc<Strategy>(doc(db, 'strategy', sid), (s) => (strategy = s));
	});

	$effect(() => {
		const cid = id;
		const unsubs = [
			listenDoc<Contact>(doc(db, 'contact', cid), (c) => {
				contact = c;
				if (c) setTitle(contactTitle(c), contactSubtitle(c) || undefined);
			}),
			listen<Activity>(
				query(collection(db, 'contact', cid, 'activity'), orderBy('at', 'desc'), limit(100)),
				(rows) => (activity = rows)
			),
			listen<Task>(
				query(
					collection(db, 'task'),
					where('contactId', '==', cid),
					where('done', '==', false),
					orderBy('dueAt'),
					limit(50)
				),
				(rows) => (tasks = rows)
			),
			// Closed ones apart, newest first, so open tasks are never cut off behind them.
			listen<Task>(
				query(
					collection(db, 'task'),
					where('contactId', '==', cid),
					where('done', '==', true),
					orderBy('dueAt', 'desc'),
					limit(20)
				),
				(rows) => (closedTasks = rows)
			),
			listen<TeamUser>(
				query(collection(db, 'user'), where('role', 'in', ['user', 'admin']), limit(200)),
				(rows) => (team = rows)
			)
		];
		return () => unsubs.forEach((u) => u());
	});

	async function act(target: `crm:${string}`, payload: Record<string, unknown>) {
		error = null;
		try {
			await callAction(target, payload);
			return true;
		} catch (e) {
			error = errorText(e);
			return false;
		}
	}

	// Note
	let note = $state('');
	async function addNote() {
		if (!note.trim()) return;
		if (await act('crm:note.add', { id, text: note })) note = '';
	}

	// Task
	let taskTitle = $state('');
	let taskDue = $state(new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10));
	async function addTask() {
		if (!taskTitle.trim()) return;
		if (await act('crm:task.create', { contactId: id, title: taskTitle, dueAt: taskDue }))
			taskTitle = '';
	}

	// Edit
	let editing = $state(false);
	let draft = $state<ContactDraft | null>(null);
	function openEdit() {
		if (!contact) return;
		draft = { ...contact, tags: (contact.tags ?? []).join(', ') };
		editing = true;
	}
	async function save() {
		if (!draft) return;
		if (await act('crm:contact.update', { id, ...draft, tags: draft.tags.split(',') }))
			editing = false;
	}

	async function remove() {
		if (
			!contact ||
			!confirm(
				`Delete ${contactTitle(contact)}, its timeline and its tasks? This cannot be undone.`
			)
		)
			return;
		if (await act('crm:contact.delete', { id })) goto('/crm');
	}

	const KIND_LABEL: Record<Activity['kind'], string> = {
		created: 'Created',
		note: 'Note',
		stage: 'Stage',
		assigned: 'Owner',
		automation: 'Automation',
		updated: 'Updated',
		meeting: 'Meeting'
	};
</script>

{#if contact === null}
	<p class="text-sm text-ink-soft">
		This contact no longer exists. <a class="text-primary-700" href="/crm">Back to CRM</a>
	</p>
{:else if contact && cfg.value}
	{@const c = contact}
	{@const config = cfg.value}
	<div class="mx-auto max-w-6xl space-y-4">
		<a href="/crm" class="inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink">
			<ArrowLeft class="h-4 w-4" /> CRM
		</a>
		<FormError message={error} />

		<div class="grid grid-cols-3 gap-4">
			<div class="col-span-2 space-y-4">
				<!-- Summary -->
				<section class="card px-5 py-4">
					<div class="flex items-start justify-between gap-4">
						<div class="min-w-0">
							<div class="flex items-center gap-2">
								<span
									class="rounded-full px-2 py-0.5 text-[11px] font-bold uppercase {typeStyle(
										config,
										c.type
									)}"
								>
									{config.pipelines[c.type].label}
								</span>
								<span class="text-xs text-ink-soft capitalize">from {c.source}</span>
								{#if c.needsAttention}
									<span class="inline-flex items-center gap-1 text-xs font-semibold text-warning">
										<TriangleAlert class="h-3.5 w-3.5" /> Needs attention
									</span>
								{/if}
							</div>
							<h2 class="mt-1 text-xl font-bold">{contactTitle(c)}</h2>
							{#if c.type === 'partner'}
								<div class="mt-0.5 flex flex-wrap gap-x-4 text-sm text-ink-soft">
									{#if contactSubtitle(c)}<span>Main contact: {contactSubtitle(c)}</span>{/if}
									{#if c.segment}<span>
											{config.segments.find((x) => x.id === c.segment)?.label ?? c.segment}
										</span>{/if}
									{#if strategy}<a href="/gtm" class="text-primary-700">
											Strategy: {strategy.name}
										</a>{/if}
								</div>
							{/if}
							<div class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-soft">
								{#if c.email}<a href="mailto:{c.email}" class="hover:text-primary-700">
										{c.email}
									</a>{/if}
								{#if c.phone}<span>{c.phone}</span>{/if}
								{#if c.linkedin}<a
										href={c.linkedin}
										target="_blank"
										rel="noopener"
										class="hover:text-primary-700"
									>
										LinkedIn
									</a>{/if}
							</div>
							{#if c.tags?.length}
								<div class="mt-2 flex flex-wrap gap-1">
									{#each c.tags as tag (tag)}
										<span class="rounded-md bg-canvas px-1.5 py-0.5 text-xs text-ink-soft">
											{tag}
										</span>
									{/each}
								</div>
							{/if}
						</div>
						<div class="flex shrink-0 gap-2">
							{#if c.type === 'fellow'}<button
									class="btn-ghost"
									onclick={() => (profileOpen = true)}
								>
									<IdCard class="h-4 w-4" /> Fellow profile
								</button>{/if}
							{#if canWrite}<button class="btn-ghost" onclick={openEdit}>
									<Pencil class="h-4 w-4" /> Edit
								</button>{/if}
							{#if canDelete && c.source !== 'portal'}<button
									class="btn-ghost text-danger"
									onclick={remove}
									title="Delete contact"
								>
									<Trash class="h-4 w-4" />
								</button>{/if}
						</div>
					</div>
					{#if c.notes}<p class="mt-3 text-sm whitespace-pre-line text-ink-soft">{c.notes}</p>{/if}
				</section>

				<!-- Pipeline -->
				<section class="card px-5 py-4">
					<div class="mb-3 eyebrow">Pipeline</div>
					<div class="flex gap-1">
						{#each config.pipelines[c.type].stages as s (s.id)}
							<button
								disabled={!canWrite}
								onclick={() => {
									if (s.id === c.stage) return;
									const reason = askReason(s, contactTitle(c));
									if (reason !== null) act('crm:contact.stage', { id, stage: s.id, reason });
								}}
								class="flex-1 rounded-md px-2 py-1.5 text-xs font-semibold {c.stage === s.id
									? 'bg-primary-600 text-white'
									: 'bg-canvas text-ink-soft hover:bg-primary-50 hover:text-primary-700'}"
							>
								{s.label}
							</button>
						{/each}
					</div>
					<div class="mt-3 flex items-center gap-3 text-sm">
						<label for="next-step" class="text-xs font-semibold text-ink-soft">Next step</label>
						<select
							id="next-step"
							class="rounded-md border border-line bg-white px-2 py-1 text-sm focus:ring-focus"
							disabled={!canWrite}
							value={c.nextStep ?? ''}
							onchange={async (e) => {
								const el = e.currentTarget;
								// On failure, show the saved value again instead of the one that was refused.
								if (!(await act('crm:contact.nextStep', { id, nextStep: el.value })))
									el.value = c.nextStep ?? '';
							}}
						>
							<option value="">None</option>
							{#each config.nextSteps as s (s.id)}
								<option value={s.id}>{s.label}</option>
							{/each}
						</select>
						{#if c.nextStep && c.ownerName}
							<span class="text-xs text-ink-soft">The owner gets a task when it changes.</span>
						{/if}
					</div>
					<p class="mt-2 text-xs text-ink-soft">
						In this stage since {formatDate(c.stageChangedAt)}. Your changes here are kept; the
						portal sheet only overwrites them when someone edits this person's row in the sheet.
					</p>
					{#if c.lostReason}
						<p class="mt-1 text-sm"><span class="font-semibold">Reason:</span> {c.lostReason}</p>
					{/if}
				</section>

				{#if c.portal}
					{@const pt = c.portal}
					<section class="card px-5 py-4">
						<div class="flex items-center justify-between">
							<div class="eyebrow">From the portal</div>
							<span class="text-xs text-ink-soft">
								synced {formatDateTime(pt.syncedAt)} · read only
							</span>
						</div>
						<dl class="mt-3 grid grid-cols-3 gap-x-6 gap-y-2 text-sm">
							{#each [['Next step', pt.nextStep], ['Scoring', pt.scoring], ['Cohort', pt.cohort], ['Pledge', pledge(pt)], ['Sherpa', pt.sherpaName], ['Archetype', pt.archetype], ['Location', pt.location], ['Funnel stage', pt.funnelStage], ['Reason lost', pt.reasonLost]] as [label, value] (label)}
								{#if value}
									<div>
										<dt class="text-xs text-ink-soft">{label}</dt>
										<dd class="font-medium">{value}</dd>
									</div>
								{/if}
							{/each}
						</dl>
						{#if pt.sheetNotes}<p class="mt-3 text-sm whitespace-pre-line text-ink-soft">
								{pt.sheetNotes}
							</p>{/if}
					</section>
				{/if}

				<!-- Timeline -->
				<section class="card">
					<div class="border-b border-line/60 px-5 py-3 font-bold">Timeline</div>
					{#if canWrite}
						<div class="flex gap-2 border-b border-line/60 px-5 py-3">
							<textarea
								class="input"
								rows="2"
								placeholder="Add a note: call summary, decision, next step…"
								bind:value={note}></textarea>
							<button class="btn-primary self-end" onclick={addNote} disabled={!note.trim()}>
								Add note
							</button>
						</div>
					{/if}
					<ul class="divide-y divide-line/40">
						{#each activity as a (a.id)}
							<li class="flex gap-3 px-5 py-2.5 text-sm">
								<span
									class="w-20 shrink-0 text-[11px] font-bold tracking-wide text-primary-600 uppercase"
								>
									{KIND_LABEL[a.kind]}
								</span>
								<div class="min-w-0 flex-1 whitespace-pre-line">{a.text}</div>
								<div class="shrink-0 text-right text-xs text-ink-soft">
									<div>{a.by}</div>
									<div>{formatDateTime(a.at)}</div>
								</div>
							</li>
						{/each}
					</ul>
				</section>
			</div>

			<div class="space-y-4">
				<section class="card px-4 py-3">
					<label class="label" for="owner">Owner (Sherpa)</label>
					<select
						id="owner"
						class="input"
						disabled={!canWrite}
						value={c.ownerUid ?? ''}
						onchange={async (e) => {
							const el = e.currentTarget;
							// Refused: show the saved owner again.
							if (!(await act('crm:contact.assign', { id, ownerUid: el.value })))
								el.value = c.ownerUid ?? '';
						}}
					>
						<option value="">No owner</option>
						{#each team as u (u.id)}<option value={u.id}>
								{u.name || u.email}{u.sherpa ? ' · Sherpa' : ''}
							</option>{/each}
					</select>
					<dl class="mt-3 space-y-1 text-xs text-ink-soft">
						<div class="flex justify-between">
							<dt>Created</dt>
							<dd>{formatDate(c.createdAt)}</dd>
						</div>
						<div class="flex justify-between">
							<dt>Last activity</dt>
							<dd>{formatDateTime(c.lastActivityAt)}</dd>
						</div>
					</dl>
				</section>

				{#if canWellbeing && perma?.length}
					<section class="card px-4 py-3">
						<div class="flex items-center justify-between">
							<span class="font-bold">Wellbeing (PERMA)</span>
							<span class="text-[11px] text-ink-soft">Restricted · not shared with Claude</span>
						</div>
						<p class="mt-1 text-xs text-ink-soft">
							Latest of {perma.length}, {formatDate(perma[0].completedAt)}
						</p>
						<div class="mt-2 grid grid-cols-5 gap-2 text-center">
							{#each PERMA_KEYS as k (k)}
								<div class="rounded-lg bg-canvas px-1 py-1.5">
									<div class="text-[10px] font-bold text-ink-soft">{PERMA_LABEL[k] ?? k}</div>
									<div class="text-sm font-bold">{perma[0].scores[k] ?? '—'}</div>
								</div>
							{/each}
						</div>
					</section>
				{/if}

				{#if canWealth && money}
					<section class="card px-4 py-3">
						<div class="flex items-center justify-between">
							<span class="font-bold">Finances</span>
							<span class="text-[11px] text-ink-soft">restricted</span>
						</div>
						<dl class="mt-2 space-y-1 text-sm">
							<div class="flex justify-between">
								<dt class="text-ink-soft">Starting income</dt>
								<dd>{eur(money.startingIncome)}</dd>
							</div>
							<div class="flex justify-between">
								<dt class="text-ink-soft">Current income</dt>
								<dd>{eur(money.currentIncome)}</dd>
							</div>
							{#if money.growth}<div class="flex justify-between">
									<dt class="text-ink-soft">Growth</dt>
									<dd>{money.growth}</dd>
								</div>{/if}
						</dl>
						{#each Object.entries(money.reports ?? {}) as [report, rows] (report)}
							<div class="mt-2 border-t border-line/50 pt-2 text-xs">
								<div class="font-semibold">{report}</div>
								{#each Object.entries(rows) as [kind, t] (kind)}
									<div class="flex justify-between text-ink-soft">
										<span>{kind}</span><span>{eur(t.value || t.net || t.gross)}</span>
									</div>
								{/each}
							</div>
						{/each}
					</section>
				{/if}

				<section class="card">
					<div class="border-b border-line/60 px-4 py-3 font-bold">Tasks</div>
					<ul class="divide-y divide-line/40">
						{#each tasks as t (t.id)}
							{@render taskRow(t)}
						{:else}
							<li class="px-4 py-3 text-sm text-ink-soft">No open tasks for this contact.</li>
						{/each}
						{#if closedTasks.length}
							<li>
								<button
									type="button"
									class="w-full px-4 py-2 text-left text-xs font-semibold text-ink-soft hover:bg-canvas"
									onclick={() => (showClosed = !showClosed)}
								>
									{showClosed ? 'Hide' : 'Show'}
									{closedTasks.length}{closedTasks.length === 20 ? '+' : ''} closed
								</button>
							</li>
							{#if showClosed}
								{#each closedTasks as t (t.id)}
									{@render taskRow(t)}
								{/each}
							{/if}
						{/if}
					</ul>
					{#if canWrite}
						<div class="space-y-2 border-t border-line/60 px-4 py-3">
							<input class="input" placeholder="New task" bind:value={taskTitle} />
							<div class="flex gap-2">
								<input class="input" type="date" bind:value={taskDue} />
								<button class="btn-primary" onclick={addTask} disabled={!taskTitle.trim()}>
									Add task
								</button>
							</div>
						</div>
					{/if}
				</section>
			</div>
		</div>
	</div>

	{#if draft}
		<Modal bind:open={editing} title="Edit contact">
			<ContactForm bind:draft {config} />
			{#snippet footer()}
				<button class="btn-ghost" onclick={() => (editing = false)}>Cancel</button>
				<button class="btn-primary" onclick={save}>Save</button>
			{/snippet}
		</Modal>
	{/if}
{:else}
	<p class="text-sm text-ink-soft">Loading…</p>
{/if}

{#if contact}<FellowProfile bind:open={profileOpen} {contact} />{/if}

{#snippet taskRow(t: Task)}
	<li class="flex items-start gap-2 px-4 py-2 text-sm">
		<input
			type="checkbox"
			class="mt-0.5 rounded text-primary-600"
			checked={t.done}
			disabled={!canWrite}
			onchange={async (e) => {
				const el = e.currentTarget;
				if (!(await act('crm:task.done', { id: t.id, done: el.checked }))) el.checked = !el.checked;
			}}
		/>
		<div class="min-w-0 flex-1">
			<div class={t.done ? 'text-ink-soft line-through' : ''}>
				<div>{t.title}</div>
				<div
					class="text-xs {!t.done && (toDate(t.dueAt)?.getTime() ?? Infinity) < Date.now()
						? 'text-danger'
						: 'text-ink-soft'}"
				>
					{t.dueAt ? `Due ${formatDate(t.dueAt)}` : 'No due date'}{t.source === 'automation'
						? ' · automation'
						: ''}
				</div>
			</div>
			{#if t.superseded}
				<div class="text-xs text-ink-soft">Closed: the contact moved on</div>
			{:else if t.removedFromSheet}
				<div class="text-xs text-ink-soft">Closed: removed from the sheet</div>
			{/if}
		</div>
	</li>
{/snippet}
