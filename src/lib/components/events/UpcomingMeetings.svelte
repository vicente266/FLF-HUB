<script lang="ts">
	import { onMount } from 'svelte';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Video from '@lucide/svelte/icons/video';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import { callAction, errorText } from '$lib/actions';
	import { formatDay, formatTime, hasPermission } from '$lib/utils';
	import type { Upcoming, UpcomingMeeting } from '$lib/types/calendar';
	import FormError from '$lib/components/shared/FormError.svelte';

	// Events → Upcoming: the Calendar connection's next days, read live (the server caches 5 minutes).
	let data = $state<Upcoming | null>(null);
	let error = $state<string | null>(null);
	let loading = $state(false);

	async function load() {
		loading = true;
		error = null;
		try {
			data = await callAction<Upcoming>('crm:events.upcoming', {}, { timeout: 60_000 });
		} catch (e) {
			error = errorText(e);
		} finally {
			loading = false;
		}
	}
	onMount(load);

	/** An all-day event's YYYY-MM-DD is that day where the reader is, not midnight UTC. */
	function startOf(m: UpcomingMeeting): Date {
		const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(m.start);
		return d ? new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3])) : new Date(m.start);
	}

	let days = $derived.by(() => {
		const out: { label: string; rows: UpcomingMeeting[] }[] = [];
		for (const m of data?.meetings ?? []) {
			const label = formatDay(startOf(m));
			if (out.at(-1)?.label !== label) out.push({ label, rows: [] });
			out.at(-1)!.rows.push(m);
		}
		return out;
	});

	const isLink = (s: string) => /^https?:\/\//.test(s);
</script>

<section class="card">
	<div class="flex items-center justify-between gap-3 border-b border-line/60 px-4 py-3">
		<h3 class="font-bold">
			Upcoming
			<span class="ml-1 text-xs font-normal text-ink-soft">
				next {data?.days ?? 30} days, from the team's calendars
			</span>
		</h3>
		<button
			class="btn-ghost shrink-0 text-xs"
			onclick={load}
			disabled={loading}
			aria-label="Refresh upcoming meetings"
		>
			<RefreshCw class="h-3.5 w-3.5 {loading ? 'animate-spin' : ''}" />
		</button>
	</div>

	<div class="px-4 py-3">
		<FormError message={error} />
		{#if !data && loading}
			<p class="text-sm text-ink-soft">Loading…</p>
		{:else if data && !data.configured}
			<p class="text-sm text-ink-soft">
				No calendar is connected yet.
				{#if hasPermission('connections.any.write')}<a
						href="/connections?open=calendar"
						class="font-semibold text-primary-700 hover:underline"
					>
						Connect a calendar in Connections → Calendar
					</a>
					to see the next {data.days} days of meetings here.{:else}An admin can connect one to show
					the next {data.days} days of meetings here.{/if}
			</p>
		{:else if data}
			{#each data.errors as e (e.calendarId)}
				<p class="mb-2 text-xs text-danger">Couldn't read {e.calendarId}: {e.message}</p>
			{/each}
			{#if !data.meetings.length}
				<p class="text-sm text-ink-soft">No meetings in the next {data.days} days.</p>
			{/if}
		{/if}
	</div>

	{#each days as d (d.label)}
		<div
			class="border-t border-line/60 bg-canvas px-4 py-1.5 text-xs font-bold tracking-wide text-ink-soft uppercase"
		>
			{d.label} · {d.rows.length}
		</div>
		<ul class="divide-y divide-line/40">
			{#each d.rows as m (`${m.calendarId}:${m.id}`)}
				<li class="flex gap-4 px-4 py-2.5 text-sm">
					<span class="w-24 shrink-0 text-xs font-semibold text-ink-soft">
						{m.allDay ? 'All day' : `${formatTime(m.start)}–${formatTime(m.end)}`}
					</span>
					<div class="min-w-0 flex-1">
						<div class="font-medium break-words">{m.title}</div>
						<div class="mt-0.5 flex flex-wrap gap-x-3 text-xs text-ink-soft">
							{#if m.meetLink}
								<a
									href={m.meetLink}
									target="_blank"
									rel="noopener noreferrer"
									class="inline-flex items-center gap-1 text-primary-700 hover:underline"
								>
									<Video class="h-3.5 w-3.5" /> Join
								</a>
							{/if}
							{#if m.location}
								<span class="inline-flex min-w-0 items-center gap-1">
									<MapPin class="h-3.5 w-3.5 shrink-0" />
									{#if isLink(m.location)}
										<a
											href={m.location}
											target="_blank"
											rel="noopener noreferrer"
											class="truncate hover:text-primary-700"
										>
											{m.location}
										</a>
									{:else}
										<span class="truncate">{m.location}</span>
									{/if}
								</span>
							{/if}
						</div>
						{#if m.attendees.length}
							<div class="mt-0.5 flex flex-wrap gap-x-2 text-xs text-ink-soft">
								{#each m.attendees as a (a.email)}
									{#if a.contactId}
										<a
											href="/crm/{a.contactId}"
											class="font-semibold text-primary-700 hover:underline"
											title={a.email}
										>
											{a.contactName}
										</a>
									{:else}
										<span title={a.email}>{a.name || a.email}</span>
									{/if}
								{/each}
							</div>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/each}
</section>
