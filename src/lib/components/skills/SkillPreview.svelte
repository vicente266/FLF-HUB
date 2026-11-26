<script lang="ts">
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import { callAction, errorText } from '$lib/actions';
	import type { Skill, SkillDetail } from '$lib/types/skills';
	import Modal from '$lib/components/shared/Modal.svelte';
	import AuditChips from './AuditChips.svelte';
	import { renderMarkdown } from './markdown';

	// One skill as it reads: its front matter, its audit and its Markdown rendered (safely: see
	// markdown.ts). The body is fetched when the dialog opens; the list carries none.
	let {
		open = $bindable(false),
		skill,
		maxBody
	}: {
		open: boolean;
		skill: Skill | null;
		/** The import's limit (characters), from the backend config. */
		maxBody: number;
	} = $props();

	let detail = $state<SkillDetail | null>(null);
	let error = $state<string | null>(null);
	let raw = $state(false);

	$effect(() => {
		if (!open || !skill) return;
		const id = skill.id;
		detail = null;
		error = null;
		raw = false;
		callAction<SkillDetail>('core:skills.get', { id })
			.then((d) => {
				if (skill?.id === id) detail = d;
			})
			.catch((e) => (error = errorText(e)));
	});

	// Relative links in a GitHub skill open next to it on GitHub.
	let html = $derived(
		detail
			? renderMarkdown(detail.content, detail.source === 'github' ? detail.url : undefined)
			: ''
	);
	let meta = $derived(Object.entries(detail?.frontMatter ?? {}));
</script>

<Modal bind:open title={skill?.name || 'Skill'} width="max-w-3xl">
	{#if error}
		<p class="text-sm text-danger">{error}</p>
	{:else if !detail}
		<p class="text-sm text-ink-soft">Loading…</p>
	{:else}
		<div class="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-soft">
			<span class="font-mono">{detail.location}</span>
			<span class="flex items-center gap-3">
				{#if detail.url}
					<a
						href={detail.url}
						target={detail.url.startsWith('/') ? undefined : '_blank'}
						rel="noopener noreferrer"
						class="inline-flex items-center gap-1 font-semibold text-primary-700 hover:underline"
					>
						{detail.url.startsWith('/') ? 'Edit in FLF TV' : 'Open the file'}
						<ExternalLink class="h-3 w-3" />
					</a>
				{/if}
				<button class="font-semibold hover:text-ink" onclick={() => (raw = !raw)}>
					{raw ? 'Rendered' : 'Markdown source'}
				</button>
			</span>
		</div>
		<div class="mb-3"><AuditChips issues={detail.audit} /></div>
		{#if raw}
			<pre
				class="max-h-[60vh] overflow-auto rounded-lg bg-canvas px-3 py-2 text-xs whitespace-pre-wrap">{detail.body}</pre>
		{:else}
			{#if meta.length}
				<dl
					class="mb-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 rounded-lg bg-canvas px-3 py-2 text-xs"
				>
					{#each meta as [k, v] (k)}
						<dt class="font-mono text-ink-soft">{k}</dt>
						<dd class="whitespace-pre-wrap">{v}</dd>
					{/each}
				</dl>
			{:else if detail.source === 'hub' && detail.description}
				<p class="mb-3 rounded-lg bg-canvas px-3 py-2 text-xs">{detail.description}</p>
			{/if}
			<div class="max-h-[60vh] overflow-auto text-sm">
				<!-- eslint-disable-next-line svelte/no-at-html-tags -- escaped in renderMarkdown -->
				{@html html}
			</div>
		{/if}
		{#if detail.truncated}
			<p class="mt-2 text-xs text-warning">
				Cut at {maxBody.toLocaleString('en')} characters: the rest is in the source.
			</p>
		{/if}
	{/if}
</Modal>
