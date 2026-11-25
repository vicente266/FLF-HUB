<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import X from '@lucide/svelte/icons/x';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import { callAction, errorText } from '$lib/actions';
	import type { TvClip } from '$lib/types/tv';

	let {
		clip,
		canWrite,
		maxSec,
		stale = false
	}: {
		clip: TvClip;
		canWrite: boolean;
		maxSec: number;
		/** Rendering, but the Mac stopped long ago: it can be edited again (the backend allows it). */
		stale?: boolean;
	} = $props();

	/** Seconds as m:ss.s (83.4 → 1:23.4). */
	const mmss = (t: number) => {
		const tenths = Math.round(t * 10);
		const m = Math.floor(tenths / 600);
		return `${m}:${((tenths - m * 600) / 10).toFixed(1).padStart(4, '0')}`;
	};
	/** m:ss.s, h:mm:ss.s or plain seconds back to seconds; NaN when unreadable. */
	function seconds(input: string): number {
		const v = input.trim().replace(',', '.');
		if (!/^\d+(\.\d+)?$|^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(v)) return NaN;
		return v.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
	}
	const STATUS: Record<string, string> = {
		suggested: 'bg-canvas text-ink-soft',
		approved: 'bg-primary-50 text-primary-700',
		rendering: 'bg-warning/10 text-warning',
		rendered: 'bg-primary-600 text-white',
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
	let draft = $state({ start: '', end: '', hook: '', caption: '', hashtags: '', focusX: 0.5 });
	/** The times as first shown, so an untouched time is not sent back rounded. */
	let shown = { start: '', end: '' };
	let error = $state<string | null>(null);
	let busy = $state(false);

	function edit() {
		draft = {
			start: mmss(clip.start),
			end: mmss(clip.end),
			hook: clip.hook,
			caption: clip.caption,
			hashtags: clip.hashtags.join(' '),
			focusX: clip.focusX ?? 0.5
		};
		shown = { start: draft.start, end: draft.end };
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

	let start = $derived(seconds(draft.start));
	let end = $derived(seconds(draft.end));
	/** What's wrong with the times, checked as the backend does; null when they are fine. */
	let timesError = $derived.by(() => {
		if (Number.isNaN(start)) return 'Start: write it as m:ss.s (1:23.4) or seconds (83.4).';
		if (Number.isNaN(end)) return 'End: write it as m:ss.s (1:23.4) or seconds (83.4).';
		if (end > maxSec + 0.5) return `End is after the video ends (${mmss(maxSec)}).`;
		if (end <= start + 3) return 'End must be at least 3 s after the start.';
		return null;
	});

	function save() {
		if (timesError) {
			error = timesError;
			return;
		}
		act('core:tv.clip.update', {
			...draft,
			start: draft.start === shown.start ? clip.start : start,
			end: draft.end === shown.end ? clip.end : end,
			hashtags: draft.hashtags.split(/[\s,]+/).filter(Boolean)
		});
	}
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
							? 'text-primary-700'
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
			{#if clip.status === 'failed' && clip.error}<p class="mt-0.5 text-xs text-danger">
					{clip.error}
				</p>{/if}
			{#if clip.reason}<p class="mt-0.5 text-xs text-ink-soft">{clip.reason}</p>{/if}
		</div>
		{#if canWrite && !editing && (clip.status !== 'rendering' || stale)}
			<div class="flex shrink-0 gap-1">
				{#if clip.status === 'suggested'}
					<button
						class="btn-primary px-2"
						title="Approve: render it"
						disabled={busy}
						onclick={() => act('core:tv.clip.status', { status: 'approved' })}
					>
						<Check class="h-4 w-4" /> Approve
					</button>
				{:else if clip.status === 'failed' || stale}
					<button
						class="btn-primary px-2"
						title="Send it to the Mac to render again"
						disabled={busy}
						onclick={() => act('core:tv.clip.status', { status: 'approved' })}
					>
						<RotateCcw class="h-4 w-4" /> Render again
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
				<label class="label" for="s-{clip.id}">Start (m:ss.s)</label>
				<input
					id="s-{clip.id}"
					class="input font-mono"
					inputmode="decimal"
					placeholder="1:23.4"
					bind:value={draft.start}
				/>
			</div>
			<div>
				<label class="label" for="e-{clip.id}">End (m:ss.s)</label>
				<input
					id="e-{clip.id}"
					class="input font-mono"
					inputmode="decimal"
					placeholder="1:58.0"
					bind:value={draft.end}
				/>
				<p class="mt-0.5 text-xs text-ink-soft" aria-live="polite">
					{#if !Number.isNaN(start) && !Number.isNaN(end) && end > start}Length {(
							end - start
						).toFixed(1)} s{:else}&nbsp;{/if}
				</p>
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
		{#if error}<p class="mt-2 text-xs text-danger" role="alert">{error}</p>{/if}
		<div class="mt-2 flex items-center justify-end gap-3">
			<p class="mr-auto text-xs text-ink-soft">
				Changing times, hook or framing renders it again; caption and hashtags don’t.
			</p>
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
	{#if clip.error && clip.status !== 'failed'}<p class="mt-2 text-xs text-danger">
			{clip.error}
		</p>{/if}
	{#if error && !editing}<p class="mt-2 text-xs text-danger" role="alert">{error}</p>{/if}
</div>
