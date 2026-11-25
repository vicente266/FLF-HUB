<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import X from '@lucide/svelte/icons/x';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import { callAction, errorText } from '$lib/actions';
	import type { TvClip } from '$lib/types/tv';

	let { clip, canWrite, maxSec }: { clip: TvClip; canWrite: boolean; maxSec: number } = $props();

	const mmss = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
	const STATUS: Record<string, string> = {
		suggested: 'bg-canvas text-ink-soft',
		approved: 'bg-primary-50 text-primary-700',
		rendering: 'bg-amber-50 text-amber-800',
		rendered: 'bg-success/10 text-success',
		rejected: 'bg-line/40 text-ink-soft line-through',
		failed: 'bg-danger/10 text-danger'
	};

	/** "clean cuts (0.8 s / 1.2 s pauses)" or which edge fell on a word. */
	function cutText(c: TvClip): string {
		const edge = (kind?: string, pause?: number) =>
			kind === 'silence' ? `${pause} s pause` : 'on a word';
		if (c.startCut === 'silence' && c.endCut === 'silence')
			return `clean cuts (${c.startPause} s / ${c.endPause} s pauses)`;
		return `start ${edge(c.startCut, c.startPause)}, end ${edge(c.endCut, c.endPause)}`;
	}

	function framing(f: number): string {
		if (f < 0.4) return 'left';
		if (f > 0.6) return 'right';
		return 'centre';
	}

	let editing = $state(false);
	let draft = $state({ start: 0, end: 0, hook: '', caption: '', hashtags: '', focusX: 0.5 });
	let error = $state<string | null>(null);
	let busy = $state(false);

	function edit() {
		draft = {
			start: clip.start,
			end: clip.end,
			hook: clip.hook,
			caption: clip.caption,
			hashtags: clip.hashtags.join(' '),
			focusX: clip.focusX ?? 0.5
		};
		error = null;
		editing = true;
	}

	async function act(
		target: 'core:tv.clip.update' | 'core:tv.clip.status',
		payload: Record<string, unknown>
	) {
		busy = true;
		error = null;
		try {
			await callAction(target, { id: clip.id, ...payload });
			editing = false;
		} catch (e) {
			error = errorText(e);
		} finally {
			busy = false;
		}
	}

	const save = () =>
		act('core:tv.clip.update', {
			...draft,
			hashtags: draft.hashtags.split(/[\s,]+/).filter(Boolean)
		});
</script>

<div class="card px-4 py-3 {clip.status === 'rejected' ? 'opacity-60' : ''}">
	<div class="flex items-start justify-between gap-3">
		<div class="min-w-0">
			<div class="flex items-center gap-2 text-xs text-ink-soft">
				<span class="font-mono">{mmss(clip.start)}–{mmss(clip.end)}</span>
				<span>· {Math.round(clip.end - clip.start)} s</span>
				<span>· score {clip.score}/10</span>
				{#if clip.startCut}
					<span
						title="Where each edge was cut"
						class={clip.startCut === 'silence' && clip.endCut === 'silence'
							? 'text-success'
							: 'text-warning'}
					>
						· {cutText(clip)}
					</span>
				{/if}
				<span
					class="rounded-full px-2 py-0.5 text-[11px] font-bold uppercase {STATUS[clip.status] ??
						''}"
				>
					{clip.status}
				</span>
			</div>
			<h4 class="mt-1 font-bold">{clip.hook}</h4>
			{#if clip.reason}<p class="mt-0.5 text-xs text-ink-soft">{clip.reason}</p>{/if}
		</div>
		{#if canWrite && !editing && clip.status !== 'rendering'}
			<div class="flex shrink-0 gap-1">
				{#if clip.status === 'suggested' || clip.status === 'failed'}
					<button
						class="btn-primary px-2"
						title="Approve: render it"
						disabled={busy}
						onclick={() => act('core:tv.clip.status', { status: 'approved' })}
					>
						<Check class="h-4 w-4" /> Approve
					</button>
				{/if}
				{#if clip.status !== 'rejected'}
					<button
						class="btn-ghost px-2"
						title="Reject"
						disabled={busy}
						onclick={() => act('core:tv.clip.status', { status: 'rejected' })}
					>
						<X class="h-4 w-4" />
					</button>
				{:else}
					<button
						class="btn-ghost px-2"
						title="Reopen"
						disabled={busy}
						onclick={() => act('core:tv.clip.status', { status: 'suggested' })}
					>
						<RotateCcw class="h-4 w-4" />
					</button>
				{/if}
				<button class="btn-ghost px-2" disabled={busy} onclick={edit}>Edit</button>
			</div>
		{/if}
	</div>

	{#if editing}
		<div class="mt-3 grid grid-cols-4 gap-2 text-sm">
			<div>
				<label class="label" for="s-{clip.id}">Start (s)</label>
				<input
					id="s-{clip.id}"
					class="input"
					type="number"
					step="0.1"
					min="0"
					max={maxSec}
					bind:value={draft.start}
				/>
			</div>
			<div>
				<label class="label" for="e-{clip.id}">End (s)</label>
				<input
					id="e-{clip.id}"
					class="input"
					type="number"
					step="0.1"
					min="0"
					max={maxSec}
					bind:value={draft.end}
				/>
			</div>
			<div class="col-span-2">
				<label class="label" for="f-{clip.id}">Framing: {framing(draft.focusX)}</label>
				<input
					id="f-{clip.id}"
					class="w-full accent-primary-600"
					type="range"
					min="0"
					max="1"
					step="0.05"
					bind:value={draft.focusX}
				/>
			</div>
			<div class="col-span-4">
				<label class="label" for="h-{clip.id}">Hook (on screen, first seconds)</label>
				<input id="h-{clip.id}" class="input" maxlength="120" bind:value={draft.hook} />
			</div>
			<div class="col-span-4">
				<label class="label" for="c-{clip.id}">Caption (post text)</label>
				<textarea id="c-{clip.id}" class="input" rows="3" bind:value={draft.caption}></textarea>
			</div>
			<div class="col-span-4">
				<label class="label" for="t-{clip.id}">Hashtags</label>
				<input id="t-{clip.id}" class="input" bind:value={draft.hashtags} />
			</div>
		</div>
		<div class="mt-2 flex justify-end gap-2">
			<button class="btn-ghost" onclick={() => (editing = false)}>Cancel</button>
			<button class="btn-primary" disabled={busy} onclick={save}>Save</button>
		</div>
	{:else}
		{#if clip.caption}<p class="mt-2 text-sm whitespace-pre-line">{clip.caption}</p>{/if}
		{#if clip.hashtags?.length}<p class="mt-1 text-xs text-primary-700">
				{clip.hashtags.join(' ')}
			</p>{/if}
	{/if}

	{#if clip.renderUrl || clip.coverUrl || clip.thumbnailUrl}
		<div class="mt-2 flex flex-wrap gap-3 text-sm font-semibold">
			{#each [['Clip', clip.renderUrl], ['Cover', clip.coverUrl], ['Thumbnail', clip.thumbnailUrl]] as [label, href] (label)}
				{#if href}
					<a
						{href}
						target="_blank"
						rel="noopener"
						class="inline-flex items-center gap-1 text-primary-700"
					>
						<ExternalLink class="h-4 w-4" />
						{label}
					</a>
				{/if}
			{/each}
		</div>
	{:else if clip.localPath}
		<p class="mt-2 text-xs text-ink-soft">
			Made on the Mac: <code>{clip.localPath}</code>{#if clip.coverLocal}, cover and thumbnail next
				to it{/if}. Set a Drive folder in Skill → Brand to upload them.
		</p>
	{/if}
	{#if clip.coverWhy}<p class="mt-1 text-xs text-ink-soft">Cover frame: {clip.coverWhy}</p>{/if}
	{#if clip.error}<p class="mt-2 text-xs text-danger">{clip.error}</p>{/if}
	{#if error}<p class="mt-2 text-xs text-danger">{error}</p>{/if}
</div>
