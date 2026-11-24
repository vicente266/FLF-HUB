<script lang="ts">
	import { collection, doc, query, where, orderBy, limit } from 'firebase/firestore';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash from '@lucide/svelte/icons/trash-2';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
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
	import { crmConfig, typeStyle } from '$lib/helpers/crmConfig.svelte';
	import type { Activity, Contact, ContactDraft, Task, TeamUser } from '$lib/types/crm';
	import Modal from '$lib/components/shared/Modal.svelte';
	import FormError from '$lib/components/shared/FormError.svelte';
	import ContactForm from '$lib/components/crm/ContactForm.svelte';

	const cfg = crmConfig();
	const canWrite = hasPermission('crm.any.write');
	const canDelete = hasPermission('crm.any.delete');

	let id = $derived(page.params.id ?? '');
	let contact = $state<Contact | null | undefined>(undefined);
	let activity = $state<Activity[]>([]);
	let tasks = $state<Task[]>([]);
	let team = $state<TeamUser[]>([]);
	let error = $state<string | null>(null);

	$effect(() => {
		const cid = id;
		const unsubs = [
			listenDoc<Contact>(doc(db, 'contact', cid), (c) => {
				contact = c;
				if (c) setTitle(c.name, c.company || undefined);
			}),
			listen<Activity>(
				query(collection(db, 'contact', cid, 'activity'), orderBy('at', 'desc'), limit(100)),
				(rows) => (activity = rows)
			),
			listen<Task>(
				query(collection(db, 'task'), where('contactId', '==', cid), orderBy('dueAt'), limit(50)),
				(rows) => (tasks = rows)
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
		if (!confirm(`Delete ${contact?.name}, its timeline and its tasks? This cannot be undone.`))
			return;
		if (await act('crm:contact.delete', { id })) goto('/crm');
	}

	const KIND_LABEL: Record<Activity['kind'], string> = {
		created: 'Created',
		note: 'Note',
		stage: 'Stage',
		assigned: 'Owner',
		automation: 'Automation',
		updated: 'Updated'
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
							<h2 class="mt-1 text-xl font-bold">{c.name}</h2>
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
							{#if canWrite}<button class="btn-ghost" onclick={openEdit}>
									<Pencil class="h-4 w-4" /> Edit
								</button>{/if}
							{#if canDelete}<button class="btn-ghost text-danger" onclick={remove} title="Delete">
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
								onclick={() => act('crm:contact.stage', { id, stage: s.id })}
								class="flex-1 rounded-md px-2 py-1.5 text-xs font-semibold {c.stage === s.id
									? 'bg-primary-600 text-white'
									: 'bg-canvas text-ink-soft hover:bg-primary-50 hover:text-primary-700'}"
							>
								{s.label}
							</button>
						{/each}
					</div>
					<p class="mt-2 text-xs text-ink-soft">
						In this stage since {formatDate(c.stageChangedAt)}.
					</p>
				</section>

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
								Add
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
						onchange={(e) => act('crm:contact.assign', { id, ownerUid: e.currentTarget.value })}
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

				<section class="card">
					<div class="border-b border-line/60 px-4 py-3 font-bold">Tasks</div>
					<ul class="divide-y divide-line/40">
						{#each tasks as t (t.id)}
							<li class="flex items-start gap-2 px-4 py-2 text-sm">
								<input
									type="checkbox"
									class="mt-0.5 rounded text-primary-600"
									checked={t.done}
									disabled={!canWrite}
									onchange={(e) =>
										act('crm:task.done', { id: t.id, done: e.currentTarget.checked })}
								/>
								<div class="min-w-0 flex-1 {t.done ? 'text-ink-soft line-through' : ''}">
									<div>{t.title}</div>
									<div
										class="text-xs {!t.done && (toDate(t.dueAt)?.getTime() ?? 0) < Date.now()
											? 'text-danger'
											: 'text-ink-soft'}"
									>
										Due {formatDate(t.dueAt)}{t.source === 'automation' ? ' · automation' : ''}
									</div>
								</div>
							</li>
						{:else}
							<li class="px-4 py-3 text-sm text-ink-soft">No tasks.</li>
						{/each}
					</ul>
					{#if canWrite}
						<div class="space-y-2 border-t border-line/60 px-4 py-3">
							<input class="input" placeholder="New task" bind:value={taskTitle} />
							<div class="flex gap-2">
								<input class="input" type="date" bind:value={taskDue} />
								<button class="btn-primary" onclick={addTask} disabled={!taskTitle.trim()}>
									Add
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
