<script lang="ts">
	import { collection, query, orderBy, limit } from 'firebase/firestore';
	import { db } from '$lib/firebase';
	import { listen, setTitle, formatDate, toDate } from '$lib/utils';
	import type { CalendarEvent } from '$lib/types/crm';
	import Empty from '$lib/components/shared/Empty.svelte';
	import UpcomingMeetings from '$lib/components/events/UpcomingMeetings.svelte';

	setTitle('Events', 'Upcoming meetings from the calendars, and past ones (via the portal sheet)');

	let events = $state<CalendarEvent[]>([]);
	let loading = $state(true);
	let search = $state('');
	// The newest meetings first; older ones load on request (search covers what is loaded).
	const PAGE = 300;
	let shown = $state(PAGE);

	$effect(() =>
		listen<CalendarEvent>(
			query(collection(db, 'event'), orderBy('date', 'desc'), limit(shown)),
			(rows) => {
				events = rows;
				loading = false;
			}
		)
	);

	const monthFmt = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' });
	let filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		if (!q) return events;
		return events.filter(
			(e) =>
				e.title.toLowerCase().includes(q) ||
				(e.name ?? '').toLowerCase().includes(q) ||
				e.participants.some((p) => p.name.toLowerCase().includes(q))
		);
	});
	let months = $derived.by(() => {
		const out: { label: string; rows: CalendarEvent[] }[] = [];
		for (const e of filtered) {
			const d = toDate(e.date);
			const label = d ? monthFmt.format(d) : 'No date';
			if (out.at(-1)?.label !== label) out.push({ label, rows: [] });
			out.at(-1)!.rows.push(e);
		}
		return out;
	});
</script>

<div class="mx-auto max-w-4xl space-y-4">
	<UpcomingMeetings />

	<h3 class="pt-2 font-bold">Meetings from the portal sheet</h3>
	<input
		class="input w-72"
		placeholder="Search a title or a person"
		aria-label="Search meetings"
		bind:value={search}
	/>

	{#if loading}
		<p class="text-sm text-ink-soft">Loading…</p>
	{:else if events.length === 0}
		<Empty title="No meetings yet">
			Meetings with contacts come in from the team's calendars when the Portal is synced. To bring
			them in now, open <a href="/connections" class="text-primary-700 hover:underline">
				Connections
			</a> and choose Sync now on the FLF Portal sheet.
		</Empty>
	{:else if filtered.length === 0}
		<Empty title="No match">No meeting has that title or person.</Empty>
	{/if}

	{#each months as m (m.label)}
		<section class="card">
			<div
				class="border-b border-line/60 px-4 py-2 text-xs font-bold tracking-wide text-ink-soft uppercase"
			>
				{m.label} · {m.rows.length}
			</div>
			<ul class="divide-y divide-line/40">
				{#each m.rows as e (e.id)}
					<li class="flex gap-4 px-4 py-2.5 text-sm">
						<span class="w-24 shrink-0 text-xs font-semibold text-ink-soft">
							{formatDate(e.date)}
						</span>
						<div class="min-w-0 flex-1">
							<div class="font-medium">
								{e.name ?? e.title}
								{#if e.showInPortal}
									<span class="ml-1 text-xs font-normal text-primary-700">· in the portal</span>
								{/if}
							</div>
							{#if e.name}<div class="text-xs text-ink-soft">{e.title}</div>{/if}
							<div class="mt-0.5 flex flex-wrap gap-x-2 text-xs text-ink-soft">
								{#each e.participants as p, i (i)}
									{#if p.contactId}
										<a href="/crm/{p.contactId}" class="hover:text-primary-700">{p.name}</a>
									{:else}
										<span>{p.name}</span>
									{/if}
								{/each}
							</div>
						</div>
					</li>
				{/each}
			</ul>
		</section>
	{/each}
	{#if events.length === shown}
		<div class="flex items-center justify-center gap-3 text-xs text-ink-soft">
			Showing and searching the latest {shown} meetings.
			<button class="btn-ghost text-xs" onclick={() => (shown += PAGE)}>Load older meetings</button>
		</div>
	{/if}
</div>
