<script lang="ts">
	import { collection, doc, query, where, orderBy, limit } from 'firebase/firestore';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash from '@lucide/svelte/icons/trash-2';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import IdCard from '@lucide/svelte/icons/id-card';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import FellowProfile from '$lib/components/crm/FellowProfile.svelte';
	import ReasonDialog from '$lib/components/crm/ReasonDialog.svelte';
	import TaskDialog from '$lib/components/crm/TaskDialog.svelte';
	import { me } from '$lib/stores';
	import { db } from '$lib/firebase';
	import { callAction, errorText } from '$lib/actions';
	import {
		hasPermission,
		listen,
		listenDoc,
		setTitle,
		formatDate,
		formatDateTime,
		relative,
		toDate
	} from '$lib/utils';
	import {
		contactSubtitle,
		askReason,
		attentionDays,
		contactTitle,
		crmBack,
		crmConfig,
		sourceLabel,
		stageLabel,
		typeStyle
	} from '$lib/helpers/crmConfig.svelte';
	import type {
		Activity,
		CalendarEvent,
		Contact,
		ContactDraft,
		Strategy,
		Task,
		TeamUser
	} from '$lib/types/crm';
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
	let meetings = $state<CalendarEvent[]>([]);
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
			listen<CalendarEvent>(
				query(
					collection(db, 'event'),
					where('contactIds', 'array-contains', cid),
					orderBy('date', 'desc'),
					limit(20)
				),
				(rows) => (meetings = rows)
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

	// Task: for the contact's owner unless someone else is picked (null = that default).
	let taskTitle = $state('');
	let taskDue = $state(new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10));
	let taskFor = $state<string | null>(null);
	let taskForDefault = $derived(contact?.ownerUid || $me?.uid || '');
	async function addTask() {
		if (!taskTitle.trim() || !taskDue) return;
		const assigneeUid = taskFor ?? taskForDefault;
		if (
			await act('crm:task.create', { contactId: id, title: taskTitle, dueAt: taskDue, assigneeUid })
		) {
			taskTitle = '';
			taskFor = null;
		}
	}
	const nameOf = (uid: string | null) =>
		uid ? (team.find((u) => u.id === uid)?.name ?? team.find((u) => u.id === uid)?.email) : null;
	let editingTask = $state<Task | null>(null);
	let taskOpen = $state(false);
	function editTask(t: Task) {
		editingTask = t;
		taskOpen = true;
	}

	// One-click moves stay; the notice offers to undo them for 8 seconds.
	interface Notice {
		text: string;
		undo: () => Promise<boolean>;
	}
	let stageNotice = $state<Notice | null>(null);
	let ownerNotice = $state<Notice | null>(null);
	let stageTimer: ReturnType<typeof setTimeout> | undefined;
	let ownerTimer: ReturnType<typeof setTimeout> | undefined;
	function showStage(n: Notice | null) {
		clearTimeout(stageTimer);
		stageNotice = n;
		if (n) stageTimer = setTimeout(() => (stageNotice = null), 8000);
	}
	function showOwner(n: Notice | null) {
		clearTimeout(ownerTimer);
		ownerNotice = n;
		if (n) ownerTimer = setTimeout(() => (ownerNotice = null), 8000);
	}
	$effect(() => () => {
		clearTimeout(stageTimer);
		clearTimeout(ownerTimer);
		clearTimeout(savedTimer);
	});
	// Another contact: no notice from the previous one.
	$effect(() => {
		void id;
		showStage(null);
		showOwner(null);
	});

	// The notice goes first, so a second click can't undo twice.
	function undoStage() {
		const n = stageNotice;
		showStage(null);
		n?.undo();
	}
	function undoOwner() {
		const n = ownerNotice;
		showOwner(null);
		n?.undo();
	}

	async function moveStage(c: Contact, to: { id: string; label: string; askReason?: boolean }) {
		if (to.id === c.stage) return;
		const reason = await askReason(to, contactTitle(c));
		if (reason === null) return;
		const back = { stage: c.stage, reason: c.lostReason ?? '' };
		if (!(await act('crm:contact.stage', { id, stage: to.id, reason }))) return;
		showStage({
			text: `Moved to ${to.label}`,
			undo: () => act('crm:contact.stage', { id, ...back })
		});
	}

	// "✓ Saved" next to the dropdown that just saved.
	let saved = $state<'owner' | 'nextStep' | null>(null);
	let savedTimer: ReturnType<typeof setTimeout> | undefined;
	function flashSaved(which: 'owner' | 'nextStep') {
		clearTimeout(savedTimer);
		saved = which;
		savedTimer = setTimeout(() => (saved = null), 2500);
	}

	async function setOwner(c: Contact, el: HTMLSelectElement) {
		const before = c.ownerUid ?? '';
		// Refused: show the saved owner again.
		if (!(await act('crm:contact.assign', { id, ownerUid: el.value }))) {
			el.value = before;
			return;
		}
		flashSaved('owner');
		showOwner({
			text: el.value ? `Owner set to ${nameOf(el.value) ?? 'them'}` : 'Owner removed',
			undo: () => act('crm:contact.assign', { id, ownerUid: before })
		});
	}

	// Edit
	let editing = $state(false);
	let draft = $state<ContactDraft | null>(null);
	let pristine = $state('');
	let editError = $state<string | null>(null);
	let savingEdit = $state(false);
	function openEdit() {
		if (!contact) return;
		// The form edits details only; owner and stage have their own controls.
		const c = contact;
		draft = {
			type: c.type,
			name: c.name,
			email: c.email,
			phone: c.phone,
			company: c.company,
			linkedin: c.linkedin,
			source: c.source,
			notes: c.notes,
			segment: c.segment,
			strategyId: c.strategyId,
			tags: (c.tags ?? []).join(', ')
		};
		pristine = JSON.stringify(draft);
		editError = null;
		editing = true;
	}
	let draftNamed = $derived(
		!!draft && (draft.type === 'partner' ? !!draft.company.trim() : !!draft.name.trim())
	);
	async function save() {
		if (!draft) return;
		savingEdit = true;
		editError = null;
		try {
			await callAction('crm:contact.update', { id, ...draft, tags: draft.tags.split(',') });
			editing = false;
		} catch (e) {
			editError = errorText(e);
		} finally {
			savingEdit = false;
		}
	}

	let moreOpen = $state(false);
	async function remove() {
		moreOpen = false;
		if (
			!contact ||
			!confirm(
				`Delete ${contactTitle(contact)}, its timeline and its tasks? This cannot be undone.`
			)
		)
			return;
		if (await act('crm:contact.delete', { id })) goto(crmBack.href);
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
		This contact no longer exists. <a class="text-primary-700" href={crmBack.href}>Back to CRM</a>
	</p>
{:else if contact && cfg.value}
	{@const c = contact}
	{@const config = cfg.value}
	{@const quiet = attentionDays(c, config.staleDays)}
	<div class="mx-auto max-w-6xl space-y-4">
		<a
			href={crmBack.href}
			class="inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
		>
			<ArrowLeft class="h-4 w-4" /> CRM
		</a>
		<FormError message={error} />

		<div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
			<div class="min-w-0 space-y-4 lg:col-span-2">
				<!-- Summary -->
				<section class="card px-5 py-4">
					<div class="flex flex-wrap items-start justify-between gap-4">
						<div class="min-w-0">
							<div class="flex flex-wrap items-center gap-2">
								<span
									class="rounded-md border border-current/20 px-2 py-0.5 text-xs font-semibold {typeStyle(
										config,
										c.type
									)}"
								>
									Type: {config.pipelines[c.type].label}
								</span>
								<span class="text-xs text-ink-soft">
									Stage: <span class="font-semibold text-ink">
										{stageLabel(config, c.type, c.stage)}
									</span>
								</span>
								<span class="text-xs text-ink-soft">· from {sourceLabel(c.source)}</span>
								{#if quiet !== null}
									<span
										class="inline-flex items-center gap-1 text-xs font-semibold text-warning"
										title="{quiet} days without activity"
									>
										<TriangleAlert class="h-3.5 w-3.5" /> Needs attention · {quiet} days without activity
									</span>
								{/if}
							</div>
							<h2 class="mt-1 text-xl font-bold break-words">{contactTitle(c)}</h2>
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
								{#if c.email}<a href="mailto:{c.email}" class="break-all hover:text-primary-700">
										{c.email}
									</a>{/if}
								{#if c.company && c.type !== 'partner'}<span>{c.company}</span>{/if}
								{#if c.phone}<span>{c.phone}</span>{/if}
								{#if c.linkedin}<a
										href={c.linkedin}
										target="_blank"
										rel="noopener"
										class="text-primary-700 hover:underline"
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
						<div class="flex shrink-0 items-start gap-2">
							{#if c.type === 'fellow'}<button
									class="btn-ghost"
									onclick={() => (profileOpen = true)}
								>
									<IdCard class="h-4 w-4" /> Fellow profile
								</button>{/if}
							{#if canWrite}<button class="btn-ghost" onclick={openEdit}>
									<Pencil class="h-4 w-4" /> Edit
								</button>{/if}
							{#if canDelete && c.source !== 'portal'}
								<div class="relative ml-2">
									<button
										class="btn-ghost px-2"
										aria-label="More"
										title="More"
										aria-expanded={moreOpen}
										onclick={() => (moreOpen = !moreOpen)}
									>
										<Ellipsis class="h-4 w-4" />
									</button>
									{#if moreOpen}
										<button
											class="fixed inset-0 z-10 cursor-default"
											aria-label="Close menu"
											onclick={() => (moreOpen = false)}
										></button>
										<div class="absolute right-0 z-20 mt-1 w-44 card py-1 shadow-lg" role="menu">
											<button
												class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-danger hover:bg-canvas"
												role="menuitem"
												onclick={remove}
											>
												<Trash class="h-4 w-4" /> Delete contact
											</button>
										</div>
									{/if}
								</div>
							{/if}
						</div>
					</div>
					{#if c.notes}<p class="mt-3 text-sm whitespace-pre-line text-ink-soft">{c.notes}</p>{/if}
				</section>

				<!-- Pipeline -->
				<section class="card px-5 py-4">
					<div class="mb-3 eyebrow">Pipeline</div>
					<div class="flex flex-wrap gap-1">
						{#each config.pipelines[c.type].stages as s (s.id)}
							<button
								disabled={!canWrite}
								onclick={() => moveStage(c, s)}
								class="min-w-24 flex-1 rounded-md px-2 py-1.5 text-xs font-semibold {c.stage ===
								s.id
									? 'bg-primary-600 text-white'
									: 'bg-canvas text-ink-soft hover:bg-primary-50 hover:text-primary-700'}"
							>
								{s.label}
							</button>
						{/each}
					</div>
					{#if stageNotice}
						<div
							class="mt-2 flex items-center gap-2 rounded-md bg-primary-50 px-3 py-1.5 text-sm"
							role="status"
						>
							<span>{stageNotice.text}</span>
							<span class="text-ink-soft">·</span>
							<button
								class="font-semibold text-primary-700 hover:underline"
								onclick={() => undoStage()}
							>
								Undo
							</button>
						</div>
					{/if}
					<div class="mt-3 flex flex-wrap items-center gap-3 text-sm">
						<label for="next-step" class="text-xs font-semibold text-ink-soft">Next step</label>
						<select
							id="next-step"
							class="rounded-md border border-line bg-white px-2 py-1 text-sm focus:ring-2 focus:ring-focus"
							disabled={!canWrite}
							value={c.nextStep ?? ''}
							onchange={async (e) => {
								const el = e.currentTarget;
								// On failure, show the saved value again instead of the one that was refused.
								if (await act('crm:contact.nextStep', { id, nextStep: el.value }))
									flashSaved('nextStep');
								else el.value = c.nextStep ?? '';
							}}
						>
							<option value="">None</option>
							{#each config.nextSteps as s (s.id)}
								<option value={s.id}>{s.label}</option>
							{/each}
						</select>
						{#if saved === 'nextStep'}
							<span class="text-xs font-semibold text-success" role="status">✓ Saved</span>
						{:else if c.nextStep && c.ownerName}
							<span class="text-xs text-ink-soft">The owner gets a task when it changes.</span>
						{/if}
					</div>
					<p class="mt-2 text-xs text-ink-soft">
						In this stage since {formatDate(c.stageChangedAt)}.{c.portal
							? ' Synced from the Portal.'
							: ''}
					</p>
					{#if c.lostReason}
						<p class="mt-1 text-sm"><span class="font-semibold">Reason:</span> {c.lostReason}</p>
					{/if}
				</section>

				{#if c.portal || c.source === 'portal'}
					{@const pt = c.portal}
					{@const rows = pt
						? [
								['Next step', pt.nextStep],
								['Scoring', pt.scoring],
								['Cohort', pt.cohort],
								['Pledge', pledge(pt)],
								['Sherpa', pt.sherpaName],
								['Archetype', pt.archetype],
								['Location', pt.location],
								['Funnel stage', pt.funnelStage],
								['Reason lost', pt.reasonLost]
							].filter(([, v]) => v)
						: []}
					<section class="card px-5 py-4">
						<div class="flex items-center justify-between gap-3">
							<div class="eyebrow">From the portal</div>
							{#if pt}<span class="text-xs text-ink-soft">
									Synced {formatDateTime(pt.syncedAt)} · read only
								</span>{/if}
						</div>
						{#if rows.length}
							<dl class="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-3">
								{#each rows as [label, value] (label)}
									<div>
										<dt class="text-xs text-ink-soft">{label}</dt>
										<dd class="font-medium">{value}</dd>
									</div>
								{/each}
							</dl>
						{:else if !pt?.sheetNotes}
							<p class="mt-2 text-sm text-ink-soft">No portal details for this person.</p>
						{/if}
						{#if pt?.sheetNotes}<p class="mt-3 text-sm whitespace-pre-line text-ink-soft">
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
							<li class="flex flex-wrap gap-x-3 gap-y-1 px-5 py-2.5 text-sm md:flex-nowrap">
								<span
									class="w-20 shrink-0 text-[11px] font-bold tracking-wide text-primary-600 uppercase"
								>
									{KIND_LABEL[a.kind]}
								</span>
								<div class="min-w-0 flex-1 break-words whitespace-pre-line">{a.text}</div>
								<div class="shrink-0 text-xs text-ink-soft md:text-right">
									<div>{a.by}</div>
									<div>{formatDateTime(a.at)}</div>
								</div>
							</li>
						{/each}
					</ul>
				</section>
			</div>

			<div class="min-w-0 space-y-4">
				<section class="card px-4 py-3">
					<div class="flex items-center justify-between">
						<label class="label" for="owner">Owner (Sherpa)</label>
						{#if saved === 'owner'}
							<span class="text-xs font-semibold text-success" role="status">✓ Saved</span>
						{/if}
					</div>
					<select
						id="owner"
						class="input"
						disabled={!canWrite}
						value={c.ownerUid ?? ''}
						onchange={(e) => setOwner(c, e.currentTarget)}
					>
						<option value="">No owner</option>
						{#each team as u (u.id)}<option value={u.id}>
								{u.name || u.email}{u.sherpa ? ' · Sherpa' : ''}
							</option>{/each}
					</select>
					{#if ownerNotice}
						<div
							class="mt-2 flex items-center gap-2 rounded-md bg-primary-50 px-3 py-1.5 text-sm"
							role="status"
						>
							<span class="min-w-0 truncate">{ownerNotice.text}</span>
							<span class="text-ink-soft">·</span>
							<button
								class="font-semibold text-primary-700 hover:underline"
								onclick={() => undoOwner()}
							>
								Undo
							</button>
						</div>
					{/if}
					<dl class="mt-3 space-y-1 text-xs text-ink-soft">
						<div class="flex justify-between">
							<dt>Created</dt>
							<dd>{formatDate(c.createdAt)}</dd>
						</div>
						<div class="flex justify-between">
							<dt>Last activity</dt>
							<dd title={formatDateTime(c.lastActivityAt)}>{relative(c.lastActivityAt)}</dd>
						</div>
					</dl>
				</section>

				{#if canWellbeing && perma?.length}
					<section class="card px-4 py-3">
						<div class="flex items-center justify-between">
							<span class="font-bold">Wellbeing (PERMA)</span>
							<span class="text-[11px] text-ink-soft" title="Not shared with Claude">
								Restricted
							</span>
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
							<span class="text-[11px] text-ink-soft" title="Not shared with Claude">
								Restricted
							</span>
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
							<input
								class="input"
								placeholder="New task"
								aria-label="New task"
								bind:value={taskTitle}
							/>
							<div class="grid grid-cols-1 gap-2">
								<input class="input" type="date" aria-label="Due" bind:value={taskDue} />
								<select
									class="input"
									aria-label="For"
									title="For"
									bind:value={() => taskFor ?? taskForDefault, (v) => (taskFor = v)}
								>
									<option value="">Nobody</option>
									{#each team as u (u.id)}<option value={u.id}>
											For {u.name || u.email}
										</option>{/each}
								</select>
							</div>
							<button
								class="btn-primary w-full justify-center"
								onclick={addTask}
								disabled={!taskTitle.trim() || !taskDue}
							>
								Add task
							</button>
						</div>
					{/if}
				</section>

				<section class="card">
					<div class="flex items-center justify-between border-b border-line/60 px-4 py-3">
						<span class="font-bold">Meetings</span>
						{#if meetings.length}<span class="text-xs text-ink-soft">
								{meetings.length}{meetings.length === 20 ? '+' : ''}
							</span>{/if}
					</div>
					<ul class="divide-y divide-line/40">
						{#each meetings as m (m.id)}
							<li class="px-4 py-2 text-sm">
								<div class="font-medium break-words">{m.name ?? m.title}</div>
								<div class="text-xs text-ink-soft">{formatDate(m.date)}</div>
							</li>
						{:else}
							<li class="px-4 py-3 text-sm text-ink-soft">
								No meetings yet. They are synced from the Portal.
							</li>
						{/each}
					</ul>
				</section>
			</div>
		</div>
	</div>

	{#if draft}
		<Modal bind:open={editing} title="Edit contact" dirty={JSON.stringify(draft) !== pristine}>
			<div class="space-y-3">
				<ContactForm bind:draft {config} />
				<FormError message={editError} />
			</div>
			{#snippet footer()}
				<button class="btn-ghost" onclick={() => (editing = false)}>Cancel</button>
				<button class="btn-primary" onclick={save} disabled={savingEdit || !draftNamed}>
					{savingEdit ? 'Saving…' : 'Save'}
				</button>
			{/snippet}
		</Modal>
	{/if}
	<TaskDialog bind:open={taskOpen} task={editingTask} {team} />
{:else}
	<p class="text-sm text-ink-soft">Loading…</p>
{/if}

<ReasonDialog />
{#if contact}<FellowProfile bind:open={profileOpen} {contact} />{/if}

{#snippet taskRow(t: Task)}
	<li class="flex items-start gap-2 px-4 py-2 text-sm">
		<input
			type="checkbox"
			class="mt-0.5 rounded text-primary-600"
			checked={t.done}
			disabled={!canWrite}
			aria-label="Done"
			onchange={async (e) => {
				const el = e.currentTarget;
				if (!(await act('crm:task.done', { id: t.id, done: el.checked }))) el.checked = !el.checked;
			}}
		/>
		<div class="min-w-0 flex-1">
			<div class={t.done ? 'text-ink-soft line-through' : ''}>
				<div class="break-words">{t.title}</div>
				<div
					class="text-xs {!t.done && (toDate(t.dueAt)?.getTime() ?? Infinity) < Date.now()
						? 'text-danger'
						: 'text-ink-soft'}"
				>
					{t.dueAt ? `Due ${formatDate(t.dueAt)}` : 'No due date'} · {nameOf(t.assigneeUid) ??
						'Nobody'}{t.source === 'automation' ? ' · Auto-created' : ''}
				</div>
			</div>
			{#if t.superseded}
				<div class="text-xs text-ink-soft">Closed: the contact moved on</div>
			{:else if t.removedFromSheet}
				<div class="text-xs text-ink-soft">Closed: removed from the Portal</div>
			{/if}
		</div>
		{#if canWrite && !t.done}
			<button
				class="shrink-0 p-0.5 text-ink-soft hover:text-ink"
				aria-label="Edit task"
				title="Edit task"
				onclick={() => editTask(t)}
			>
				<Pencil class="h-3.5 w-3.5" />
			</button>
		{/if}
	</li>
{/snippet}
