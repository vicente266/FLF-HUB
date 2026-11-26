<script lang="ts">
	// Every skill for Claude and agents (FLF TV, the Hub, GitHub, Drive): the Skills tab of Knowledge.
	import { onMount } from 'svelte';
	import Plus from '@lucide/svelte/icons/plus';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash from '@lucide/svelte/icons/trash-2';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import { callAction, errorText } from '$lib/actions';
	import { hasPermission, formatDate, formatDateTime } from '$lib/utils';
	import type { Skill, SkillSourceReport, SkillsConfig } from '$lib/types/skills';
	import AuditChips from '$lib/components/skills/AuditChips.svelte';
	import SkillModal from '$lib/components/skills/SkillModal.svelte';
	import SkillPreview from '$lib/components/skills/SkillPreview.svelte';
	import FormError from '$lib/components/shared/FormError.svelte';
	import Empty from '$lib/components/shared/Empty.svelte';

	const canWrite = hasPermission('skills.any.write');
	let skills = $state<Skill[]>([]);
	let full = $state(false);
	// Sources, levels and limits are defined in the backend (functions/src/lib/skills/config.ts).
	let config = $state<SkillsConfig | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	async function load() {
		try {
			const [c, l] = await Promise.all([
				callAction<SkillsConfig>('core:skills.config.get'),
				callAction<{ skills: Skill[]; full: boolean }>('core:skills.list')
			]);
			config = c;
			skills = l.skills;
			full = l.full;
		} catch (e) {
			error = errorText(e);
		} finally {
			loading = false;
		}
	}
	onMount(load);

	const errors = (s: Skill) => s.audit.filter((i) => i.level === 'error').length;
	const warnings = (s: Skill) => s.audit.filter((i) => i.level === 'warning').length;
	const sourceLabel = (id: string) => config?.sources.find((s) => s.id === id)?.label ?? id;

	let stats = $derived({
		total: skills.length,
		errors: skills.filter((s) => errors(s) > 0).length,
		warnings: skills.filter((s) => warnings(s) > 0).length,
		bySource: (config?.sources ?? []).map((s) => ({
			...s,
			count: skills.filter((x) => x.source === s.id).length
		}))
	});

	let search = $state('');
	let sourceFilter = $state('');
	let levelFilter = $state<'' | 'error' | 'warning' | 'clean'>('');
	let rows = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return skills
			.filter((s) => !sourceFilter || s.source === sourceFilter)
			.filter((s) => {
				if (levelFilter === 'error') return errors(s) > 0;
				if (levelFilter === 'warning') return warnings(s) > 0;
				if (levelFilter === 'clean') return !s.audit.length;
				return true;
			})
			.filter(
				(s) =>
					!q ||
					[s.name, s.description, s.location, ...s.audit.map((i) => i.message)]
						.join(' ')
						.toLowerCase()
						.includes(q)
			)
			.sort(
				(a, b) => errors(b) - errors(a) || warnings(b) - warnings(a) || a.name.localeCompare(b.name)
			);
	});

	// Import every source now.
	let syncing = $state(false);
	let syncResult = $state<string | null>(null);
	const reportLine = (name: string, r: SkillSourceReport) =>
		r.configured
			? `${name}: ${r.files} files, ${r.added} new, ${r.updated} updated, ${r.removed} removed`
			: `${name}: not set up`;
	async function sync() {
		syncing = true;
		error = null;
		syncResult = null;
		try {
			const r = await callAction<{ github: SkillSourceReport; drive: SkillSourceReport }>(
				'core:skills.sync',
				{},
				{ timeout: 300_000 }
			);
			syncResult = `${reportLine('GitHub', r.github)}. ${reportLine('Drive', r.drive)}.`;
			await load();
		} catch (e) {
			error = errorText(e);
		} finally {
			syncing = false;
		}
	}

	let previewOpen = $state(false);
	let previewing = $state<Skill | null>(null);
	function preview(s: Skill) {
		previewing = s;
		previewOpen = true;
	}

	let editOpen = $state(false);
	let editing = $state<Skill | null>(null);
	function edit(s: Skill | null) {
		editing = s;
		editOpen = true;
	}

	let deletingId = $state<string | null>(null);
	async function remove(s: Skill) {
		if (deletingId || !confirm(`Delete the skill "${s.name}"? This cannot be undone.`)) return;
		error = null;
		deletingId = s.id;
		try {
			await callAction('core:skills.delete', { id: s.id });
			await load();
		} catch (e) {
			error = errorText(e);
		} finally {
			deletingId = null;
		}
	}

	/** The last import of each source, with what it couldn't read. */
	let lastSync = $derived(
		(
			[
				['GitHub', config?.lastSync.github],
				['Drive', config?.lastSync.drive]
			] as const
		).filter(([, r]) => !!r) as [string, SkillSourceReport & { at: number | null }][]
	);
</script>

<div class="mx-auto max-w-7xl space-y-4">
	<FormError message={error} />

	<!-- Counts, sources and actions on one line. -->
	<div class="flex flex-wrap items-end justify-between gap-4">
		<div class="flex flex-wrap items-baseline gap-6">
			<span>
				<span class="text-3xl font-bold">{stats.total}</span>
				{stats.total === 1 ? 'skill' : 'skills'}
			</span>
			<button
				class="text-left"
				onclick={() => (levelFilter = levelFilter === 'error' ? '' : 'error')}
				title="Show only skills with an error"
			>
				<span class="text-3xl font-bold {stats.errors ? 'text-danger' : ''}">{stats.errors}</span>
				with errors
			</button>
			<button
				class="text-left"
				onclick={() => (levelFilter = levelFilter === 'warning' ? '' : 'warning')}
				title="Show only skills with a warning"
			>
				<span class="text-3xl font-bold {stats.warnings ? 'text-warning' : ''}">
					{stats.warnings}
				</span>
				with warnings
			</button>
			<span class="text-xs text-ink-soft">
				{stats.bySource.map((s) => `${s.label} ${s.count}`).join(' · ')}
			</span>
		</div>
		<div class="flex flex-wrap items-center gap-2 text-xs">
			{#if config}
				<span class="text-ink-soft">
					{#if config.repos.length}
						GitHub: {config.repos.join(', ')}
					{:else}
						<a href="/connections" class="text-primary-700 hover:underline">GitHub not set up</a>
					{/if}
					·
					{#if config.folder}
						<a
							href={config.folder.url}
							target="_blank"
							rel="noopener noreferrer"
							class="text-primary-700 hover:underline"
						>
							Skills folder in Drive
						</a>
					{:else}
						<a href="/connections" class="text-primary-700 hover:underline">Drive not set up</a>
					{/if}
					· imported every night
				</span>
			{/if}
			{#if canWrite}
				<button class="btn-ghost text-xs" disabled={syncing} onclick={sync}>
					<RefreshCw class="h-3.5 w-3.5 {syncing ? 'animate-spin' : ''}" />
					{syncing ? 'Importing…' : 'Sync now'}
				</button>
				<button class="btn-primary text-xs" disabled={!config} onclick={() => edit(null)}>
					<Plus class="h-4 w-4" /> Add skill
				</button>
			{/if}
		</div>
	</div>
	{#if syncResult}<p class="text-xs text-ink">{syncResult}</p>{/if}
	{#if lastSync.length}
		<div class="flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-soft">
			{#each lastSync as [name, r] (name)}
				<span>
					{reportLine(name, r)} · {formatDateTime(r.at)}
					{#if r.skipped.length}
						<details class="inline">
							<summary class="font-semibold text-warning">
								{r.skipped.length} not read
							</summary>
							<ul class="mt-1 list-disc pl-5">
								{#each r.skipped as line, n (n)}<li>{line}</li>{/each}
							</ul>
						</details>
					{/if}
				</span>
			{/each}
		</div>
	{/if}
	{#if full}
		<p class="text-xs text-warning">
			The list is at its limit ({config?.limits.maxSkills}): new skills are not imported.
		</p>
	{/if}

	<!-- Filters. -->
	<div class="flex flex-wrap items-center gap-2">
		<input
			class="input w-72"
			placeholder="Search name, description, location or issue"
			bind:value={search}
		/>
		<select class="input w-auto pr-9" bind:value={sourceFilter} aria-label="Source">
			<option value="">All sources</option>
			{#each config?.sources ?? [] as s (s.id)}<option value={s.id}>{s.label}</option>{/each}
		</select>
		<select class="input w-auto pr-9" bind:value={levelFilter} aria-label="Audit">
			<option value="">Any audit</option>
			<option value="error">With errors</option>
			<option value="warning">With warnings</option>
			<option value="clean">No issues</option>
		</select>
	</div>

	<section class="overflow-x-auto card">
		{#if loading}
			<p class="px-4 py-4 text-sm text-ink-soft">Loading…</p>
		{:else if !skills.length}
			<div class="px-4 py-2">
				<Empty title="No skills yet">
					Set up the GitHub repos and the Skills folder on Connections and press Sync now, or add a
					skill written here.
				</Empty>
			</div>
		{:else}
			<table class="w-full text-sm">
				<thead>
					<tr class="border-b border-line/60 text-left text-xs font-semibold text-ink-soft">
						<th class="px-4 py-2">Skill</th>
						<th class="px-3 py-2">Source</th>
						<th class="px-3 py-2">Audit</th>
						<th class="px-3 py-2">Last updated</th>
						<th class="px-3 py-2"><span class="sr-only">Actions</span></th>
					</tr>
				</thead>
				<tbody class="divide-y divide-line/40">
					{#each rows as s (s.id)}
						<tr class="align-top">
							<td class="max-w-xl px-4 py-3">
								<button
									type="button"
									class="text-left font-semibold hover:text-primary-700"
									title="Read the skill"
									onclick={() => preview(s)}
								>
									{s.name}
								</button>
								{#if s.description}
									<p class="mt-0.5 line-clamp-2 text-xs text-ink">{s.description}</p>
								{/if}
								<div class="mt-1 font-mono text-xs text-ink-soft">
									{#if s.url}
										<a
											href={s.url}
											target={s.url.startsWith('/') ? undefined : '_blank'}
											rel="noopener noreferrer"
											class="inline-flex min-w-0 items-center gap-1 break-all hover:text-primary-700"
										>
											{s.location}
											<ExternalLink class="h-3 w-3 shrink-0" />
										</a>
									{:else}
										{s.location}
									{/if}
									{#if s.truncated}· cut at {config?.limits.maxBody.toLocaleString('en')} characters{/if}
								</div>
							</td>
							<td class="px-3 py-3 whitespace-nowrap">{sourceLabel(s.source)}</td>
							<td class="max-w-sm px-3 py-3"><AuditChips issues={s.audit} /></td>
							<td class="px-3 py-3 whitespace-nowrap">
								<div>{formatDate(s.updatedAt)}</div>
								<div class="max-w-36 truncate text-xs text-ink-soft">{s.updatedBy}</div>
							</td>
							<td class="px-3 py-3 whitespace-nowrap">
								{#if canWrite && s.source === 'hub'}
									<button class="btn-ghost px-2" aria-label="Edit" onclick={() => edit(s)}>
										<Pencil class="h-4 w-4" />
									</button>
									<button
										class="btn-ghost px-2 text-danger"
										aria-label="Delete"
										disabled={deletingId === s.id}
										onclick={() => remove(s)}
									>
										<Trash class="h-4 w-4" />
									</button>
								{/if}
							</td>
						</tr>
					{:else}
						<tr><td colspan="5" class="px-4 py-4 text-sm text-ink-soft">No skill matches.</td></tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</section>
	{#if config}
		<p class="text-xs text-ink-soft">
			A skill is a Markdown file of instructions for Claude or an agent. GitHub: {config.patterns.join(
				', '
			)}. Drive: Markdown, text and Google Docs in the Skills folder. The audit runs on every import
			and save: name and description (starting “Use when”, {config.limits.minDescription}–{config
				.limits.maxDescription} characters), body (at most {config.limits.maxLines} lines), front matter,
			links to files in the same repo, the same name twice, and no change in {config.limits
				.staleDays} days. Skills from FLF TV, GitHub and Drive are edited where they live.
		</p>
	{/if}
</div>

{#if config}
	<SkillModal bind:open={editOpen} skill={editing} limits={config.limits} onsaved={load} />
	<SkillPreview bind:open={previewOpen} skill={previewing} maxBody={config.limits.maxBody} />
{/if}
