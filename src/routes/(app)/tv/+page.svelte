<script lang="ts">
	import { onMount } from 'svelte';
	import { collection, query, orderBy, limit, where } from 'firebase/firestore';
	import Upload from '@lucide/svelte/icons/upload';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Trash from '@lucide/svelte/icons/trash-2';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import Check from '@lucide/svelte/icons/check';
	import { db } from '$lib/firebase';
	import { callAction, errorText } from '$lib/actions';
	import { hasPermission, listen, setTitle, relative } from '$lib/utils';
	import type { TvBrand, TvClip, TvSkill, TvVideo } from '$lib/types/tv';
	import ClipCard from '$lib/components/tv/ClipCard.svelte';
	import FormError from '$lib/components/shared/FormError.svelte';
	import Empty from '$lib/components/shared/Empty.svelte';

	setTitle(
		'FLF TV',
		'Send a video from Drive: the Mac finds the clips, cuts them, subtitles them and makes the covers'
	);

	const canWrite = hasPermission('tv.any.write');
	const TABS = [
		['upload', 'Upload'],
		['skill', 'Skill'],
		['outcome', 'Outcome']
	] as const;
	let tab = $state<'upload' | 'skill' | 'outcome'>('upload');
	let error = $state<string | null>(null);

	// ---- videos, the selected one, its clips
	let videos = $state<TvVideo[]>([]);
	let selected = $state<string | null>(null);
	let clips = $state<TvClip[]>([]);
	$effect(() =>
		listen<TvVideo>(
			query(collection(db, 'tvVideo'), orderBy('createdAt', 'desc'), limit(100)),
			(rows) => {
				videos = rows;
				if (!selected && rows.length) selected = rows[0].id;
			}
		)
	);
	$effect(() => {
		const id = selected;
		clips = [];
		if (!id) return;
		return listen<TvClip>(
			query(collection(db, 'tvClip'), where('videoId', '==', id), orderBy('index'), limit(50)),
			(rows) => (clips = rows)
		);
	});
	let video = $derived(videos.find((v) => v.id === selected) ?? null);

	// ---- Upload: send a Drive video
	let url = $state('');
	let title = $state('');
	let sending = $state(false);
	async function send() {
		sending = true;
		error = null;
		try {
			const r = await callAction<{ id: string }>('core:tv.video.add', { url, title });
			selected = r.id;
			url = '';
			title = '';
		} catch (e) {
			error = errorText(e);
		} finally {
			sending = false;
		}
	}
	async function videoAct(target: 'core:tv.video.retry' | 'core:tv.video.delete', id: string) {
		if (
			target === 'core:tv.video.delete' &&
			!confirm('Delete this video and its clips from FLF TV? The Drive files stay.')
		)
			return;
		error = null;
		try {
			await callAction(target, { id });
			if (target === 'core:tv.video.delete') selected = null;
		} catch (e) {
			error = errorText(e);
		}
	}

	/**
	 * The pipeline, in its order. Each step is done, running, waiting or failed, from the video's
	 * status and step (the worker writes them) and, for the last one, its clips.
	 */
	const STEPS = [
		['transcribing', '① Transcript', 'Whisper on the Mac, a time for every word'],
		['pauses', '② Pauses + transcript', 'ffmpeg measures every silence in the audio'],
		[
			'topics',
			'③ Topics and clips',
			'Claude reads it with the Skill, maps the topics, picks the clips and their exact cuts'
		],
		[
			'render',
			'④ Cuts, subtitles, covers',
			'Each clip cut inside its pauses, subtitled, with cover and thumbnail'
		]
	] as const;
	const ORDER = ['downloading', 'transcribing', 'pauses', 'topics'];
	function stepState(
		v: TvVideo,
		key: string,
		list: TvClip[]
	): 'done' | 'running' | 'waiting' | 'failed' {
		if (key === 'render') {
			if (v.status !== 'review') return 'waiting';
			const live = list.filter((c) => c.status !== 'rejected');
			if (live.some((c) => c.status === 'failed')) return 'failed';
			if (live.length && live.every((c) => c.status === 'rendered')) return 'done';
			return live.some((c) => ['approved', 'rendering'].includes(c.status)) ? 'running' : 'waiting';
		}
		if (v.status === 'review') return 'done';
		if (v.status === 'queued') return 'waiting';
		const at = ORDER.indexOf(v.step ?? 'downloading');
		const mine = ORDER.indexOf(key);
		if (v.status === 'failed') {
			const failedAt = Math.max(at, 1);
			if (mine < failedAt) return 'done';
			if (mine === failedAt) return 'failed';
			return 'waiting';
		}
		if (mine < at) return 'done';
		return mine === at || (key === 'transcribing' && at === 0) ? 'running' : 'waiting';
	}
	const STATE_STYLE = {
		done: 'border-success/40 bg-success/5',
		running: 'border-primary-300 bg-primary-50',
		waiting: 'border-line/60 bg-white opacity-70',
		failed: 'border-danger/40 bg-danger/5'
	};
	function rendered(list: TvClip[]): string {
		const live = list.filter((c) => c.status !== 'rejected');
		return live.length
			? `${live.filter((c) => c.status === 'rendered').length} of ${live.length} clips ready`
			: '';
	}
	function summary(v: TvVideo): string {
		if (v.status === 'queued') return 'Waiting for the Mac';
		if (v.status === 'processing') return 'Processing on the Mac…';
		if (v.status === 'failed') return 'Failed';
		return `${v.clipCount} clips`;
	}

	// ---- Skill: Clipping and Brand
	let skillTab = $state<'clipping' | 'brand'>('clipping');
	let skill = $state<Record<string, TvSkill | null>>({ clipping: null, brand: null });
	let text = $state<Record<string, string>>({ clipping: '', brand: '' });
	let brand = $state<TvBrand>({});
	let defaults = $state<TvBrand>({});
	let saving = $state(false);
	let saved = $state<string | null>(null);
	async function loadSkill(id: 'clipping' | 'brand') {
		const s = await callAction<TvSkill>('core:tv.skill.get', { id });
		skill[id] = s;
		text[id] = s.text;
		if (s.brand) brand = { ...s.brand };
	}
	onMount(() => {
		callAction<{ defaultBrand: TvBrand }>('core:tv.config.get').then(
			(c) => (defaults = c.defaultBrand)
		);
		loadSkill('clipping');
		loadSkill('brand');
	});
	async function saveSkill() {
		const id = skillTab;
		saving = true;
		error = null;
		saved = null;
		try {
			const s = await callAction<TvSkill>('core:tv.skill.save', {
				id,
				text: text[id],
				...(id === 'brand' ? { brand } : {})
			});
			skill[id] = s;
			saved = `Saved as version ${s.version}. The next video uses it.`;
		} catch (e) {
			error = errorText(e);
		} finally {
			saving = false;
		}
	}
	async function resetSkill() {
		const id = skillTab;
		if (!confirm('Go back to the built-in version? Your edits are lost.')) return;
		const s = await callAction<TvSkill>('core:tv.skill.reset', { id });
		skill[id] = s;
		text[id] = s.text;
		if (s.brand) brand = { ...s.brand };
	}
	const BRAND_FIELDS: [string, string][] = [
		['highlightColor', 'Spoken word colour'],
		['textColor', 'Caption colour'],
		['cardColor', 'Card colour'],
		['cardTextColor', 'Card text colour'],
		['captionSize', 'Caption size (px)'],
		['captionMarginV', 'Caption height from bottom (px)'],
		['wordsPerLine', 'Words on screen'],
		['hookSeconds', 'Hook seconds'],
		['hookSize', 'Hook size (px)'],
		['endCardSeconds', 'End card seconds (0 = none)'],
		['endCardTitle', 'End card title'],
		['endCardCta', 'End card link'],
		['minSeconds', 'Shortest clip (s)'],
		['maxSeconds', 'Longest clip (s)'],
		['maxClips', 'Clips per video'],
		['outputFolderId', 'Drive folder for clips (id)']
	];
	const kind = (k: string) => typeof (defaults[k] ?? brand[k]);
	const mmss = (t: number) =>
		`${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
</script>

<div class="mx-auto max-w-6xl space-y-4">
	<div class="flex items-center justify-between">
		<div class="flex rounded-lg border border-line/70 bg-white p-0.5">
			{#each TABS as [value, label] (value)}
				<button
					class="rounded-md px-4 py-1 text-sm font-semibold {tab === value
						? 'bg-primary-600 text-white'
						: 'text-ink-soft hover:text-ink'}"
					onclick={() => {
						tab = value;
						saved = null;
					}}
				>
					{label}
				</button>
			{/each}
		</div>
		<p class="text-xs text-ink-soft">
			Whisper, ffmpeg and rendering run on the Mac (<code>tv-worker</code>); the Skill lives here.
		</p>
	</div>
	<FormError message={error} />

	{#if tab === 'upload'}
		{#if canWrite}
			<div class="card px-5 py-4">
				<p class="eyebrow">Send a video from Google Drive</p>
				<div class="mt-3 flex items-end gap-2">
					<div class="flex-1">
						<label class="label" for="tv-url">Drive link</label>
						<input
							id="tv-url"
							class="input"
							placeholder="https://drive.google.com/file/d/…"
							bind:value={url}
						/>
					</div>
					<div class="w-80">
						<label class="label" for="tv-title">Title (shown on the covers)</label>
						<input
							id="tv-title"
							class="input"
							placeholder="FLF Podcast #12 — Aleks on the long game"
							bind:value={title}
						/>
					</div>
					<button class="btn-primary py-2" onclick={send} disabled={sending || !url.trim()}>
						<Upload class="h-4 w-4" /> Send
					</button>
				</div>
				<p class="mt-2 text-xs text-ink-soft">
					Share the file with the Mac worker’s Google account. Everything after this is automatic.
				</p>
			</div>
		{/if}

		{#if videos.length === 0}
			<Empty title="No videos yet">
				Send one: you will see it go through the four steps below.
			</Empty>
		{:else}
			<div class="grid grid-cols-3 gap-4">
				<ul class="divide-y divide-line/40 self-start card">
					{#each videos as v (v.id)}
						<li>
							<button
								class="w-full px-4 py-2.5 text-left hover:bg-canvas {selected === v.id
									? 'bg-primary-50'
									: ''}"
								onclick={() => (selected = v.id)}
							>
								<div class="truncate text-sm font-semibold">{v.title}</div>
								<div class="text-xs text-ink-soft">{summary(v)} · {relative(v.createdAt)}</div>
							</button>
						</li>
					{/each}
				</ul>
				{#if video}
					<div class="col-span-2 space-y-3">
						<div class="flex items-start justify-between gap-3 card px-4 py-3">
							<div class="min-w-0">
								<h3 class="font-bold">{video.title}</h3>
								<p class="text-xs text-ink-soft">
									{video.durationSec ? `${Math.round(video.durationSec / 60)} min · ` : ''}sent by {video.createdBy}
									{relative(video.createdAt)}
								</p>
							</div>
							<div class="flex shrink-0 gap-1">
								<a
									class="btn-ghost px-2"
									href={video.driveUrl}
									target="_blank"
									rel="noopener"
									title="Open in Drive"
								>
									<ExternalLink class="h-4 w-4" />
								</a>
								{#if canWrite && video.status !== 'processing'}
									<button
										class="btn-ghost px-2"
										title="Run again with the current Skill"
										onclick={() => videoAct('core:tv.video.retry', video!.id)}
									>
										<RefreshCw class="h-4 w-4" />
									</button>
									<button
										class="btn-ghost px-2 text-danger"
										title="Delete"
										onclick={() => videoAct('core:tv.video.delete', video!.id)}
									>
										<Trash class="h-4 w-4" />
									</button>
								{/if}
							</div>
						</div>
						<ol class="space-y-2">
							{#each STEPS as [key, label, help] (key)}
								{@const st = stepState(video, key, clips)}
								<li class="flex items-center gap-3 rounded-xl border px-4 py-3 {STATE_STYLE[st]}">
									<span
										class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold {st ===
										'done'
											? 'bg-success text-white'
											: 'bg-white text-ink-soft'}"
									>
										{#if st === 'done'}<Check class="h-4 w-4" />{:else if st === 'running'}<span
												class="h-2 w-2 animate-pulse rounded-full bg-primary-600"
											></span>{/if}
									</span>
									<div class="min-w-0 flex-1">
										<div class="text-sm font-semibold">{label}</div>
										<div class="text-xs text-ink-soft">
											{key === 'render' && rendered(clips) ? rendered(clips) : help}
										</div>
									</div>
									{#if st === 'failed' && video.error && key !== 'render'}<span
											class="max-w-xs text-xs text-danger"
										>
											{video.error}
										</span>{/if}
								</li>
							{/each}
						</ol>
						{#if video.status === 'review'}
							<button class="btn-ghost" onclick={() => (tab = 'outcome')}>See the outcome →</button>
						{/if}
					</div>
				{/if}
			</div>
		{/if}
	{:else if tab === 'skill'}
		<div class="flex w-fit rounded-lg border border-line/70 bg-white p-0.5">
			{#each [['clipping', 'Clipping'], ['brand', 'Brand and covers']] as [value, label] (value)}
				<button
					class="rounded-md px-3 py-1 text-sm font-semibold {skillTab === value
						? 'bg-primary-50 text-primary-700'
						: 'text-ink-soft'}"
					onclick={() => {
						skillTab = value as 'clipping' | 'brand';
						saved = null;
					}}
				>
					{label}
				</button>
			{/each}
		</div>
		{@const s = skill[skillTab]}
		<div class="grid grid-cols-3 gap-4">
			<section class="col-span-2 card px-4 py-3">
				<div class="flex items-center justify-between">
					<div>
						<h3 class="font-bold">
							{skillTab === 'clipping' ? 'Clipping skill' : 'Brand and covers skill'}
						</h3>
						<p class="text-xs text-ink-soft">
							{#if s}{s.isDefault
									? 'Built-in version'
									: `Version ${s.version}, by ${s.updatedBy} ${relative(s.updatedAt)}`}{/if}
						</p>
					</div>
					{#if canWrite}
						<div class="flex gap-2">
							{#if s && !s.isDefault}<button class="btn-ghost" onclick={resetSkill}>
									Built-in version
								</button>{/if}
							<button class="btn-primary" disabled={saving} onclick={saveSkill}>Save</button>
						</div>
					{/if}
				</div>
				{#if saved}<p class="mt-2 text-sm text-primary-700">{saved}</p>{/if}
				<textarea
					class="mt-3 input font-mono text-xs leading-relaxed"
					rows="28"
					readonly={!canWrite}
					bind:value={text[skillTab]}></textarea>
			</section>
			<aside class="space-y-3">
				{#if skillTab === 'clipping'}
					<div class="card px-4 py-3 text-sm text-ink-soft">
						<p class="font-semibold text-ink">How the Mac uses it</p>
						<ol class="mt-2 list-decimal space-y-1 pl-4">
							<li><strong>Transcript:</strong> Whisper gives every word its time.</li>
							<li>
								<strong>Pauses:</strong> ffmpeg measures each silence; the transcript is marked with them
								(⏸ 0.8s).
							</li>
							<li>
								<strong>Topics and clips:</strong> Claude reads it with this skill, maps the topics and
								picks clips that start after a pause at a new topic and end after their payoff.
							</li>
							<li>
								<strong>Cuts:</strong> the code moves each cut inside the real pause, so no word or breath
								is clipped.
							</li>
						</ol>
						<p class="mt-2">
							The answer format and the length limits are added by the worker: editing this text
							can’t break it.
						</p>
					</div>
				{:else}
					<div class="card px-4 py-3">
						<p class="text-sm font-semibold">Renderer settings</p>
						<div class="mt-2 space-y-2">
							{#each BRAND_FIELDS as [key, label] (key)}
								{#if key in brand}
									<div>
										<label class="label" for="b-{key}">{label}</label>
										{#if key.endsWith('Color')}
											<div class="flex gap-2">
												<input
													id="b-{key}"
													type="color"
													class="h-8 w-10 rounded border-line"
													disabled={!canWrite}
													bind:value={brand[key] as string}
												/>
												<input
													class="input font-mono"
													disabled={!canWrite}
													bind:value={brand[key] as string}
												/>
											</div>
										{:else if kind(key) === 'number'}
											<input
												id="b-{key}"
												class="input"
												type="number"
												disabled={!canWrite}
												bind:value={brand[key] as number}
											/>
										{:else}
											<input
												id="b-{key}"
												class="input"
												disabled={!canWrite}
												bind:value={brand[key] as string}
											/>
										{/if}
									</div>
								{/if}
							{/each}
							<label class="flex items-center gap-2 text-sm">
								<input
									type="checkbox"
									class="rounded text-primary-600"
									disabled={!canWrite}
									bind:checked={brand.logo as boolean}
								/> FLF logo in the corner
							</label>
							<label class="flex items-center gap-2 text-sm">
								<input
									type="checkbox"
									class="rounded text-primary-600"
									disabled={!canWrite}
									bind:checked={brand.autoRender as boolean}
								/> Render clips straight away (no Approve step)
							</label>
						</div>
					</div>
				{/if}
			</aside>
		</div>
	{:else}
		{#if !video}
			<Empty title="Nothing yet">Send a video in Upload.</Empty>
		{:else}
			<div class="flex items-center gap-2">
				<label class="label mb-0" for="tv-video">Video</label>
				<select id="tv-video" class="input w-96" bind:value={selected}>
					{#each videos as v (v.id)}<option value={v.id}>{v.title}</option>{/each}
				</select>
				<span class="text-xs text-ink-soft">{rendered(clips)}</span>
			</div>
			{#if video.topics?.length}
				<section class="card px-4 py-3">
					<p class="eyebrow">Topics</p>
					<ol class="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
						{#each video.topics as t, i (i)}
							<li class="flex gap-2">
								<span class="w-24 shrink-0 font-mono text-xs text-ink-soft">
									{mmss(t.start)}–{mmss(t.end)}
								</span>
								<span>
									<strong>{t.title}</strong>
									{#if t.summary}<span class="text-ink-soft">— {t.summary}</span>{/if}
								</span>
							</li>
						{/each}
					</ol>
				</section>
			{/if}
			<div class="space-y-3">
				{#each clips as c (c.id)}
					<ClipCard clip={c} {canWrite} maxSec={video.durationSec ?? 99999} />
				{:else}
					<p class="text-sm text-ink-soft">
						{video.status === 'review'
							? 'Claude found no clip worth cutting. Adjust the Skill and run it again (↻ in Upload).'
							: 'The clips appear here as the Mac makes them.'}
					</p>
				{/each}
			</div>
		{/if}
	{/if}
</div>
