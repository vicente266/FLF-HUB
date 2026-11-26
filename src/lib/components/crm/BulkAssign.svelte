<script lang="ts">
	import { collection, getDocs, limit, query, where } from 'firebase/firestore';
	import { db } from '$lib/firebase';
	import { callAction, errorText } from '$lib/actions';
	import type { TeamUser } from '$lib/types/crm';

	// The CRM list's selection bar ("N selected · Assign to … · Clear") and its result notice with Undo.
	let {
		ids,
		onclear,
		onerror
	}: { ids: string[]; onclear: () => void; onerror: (message: string | null) => void } = $props();

	interface Result {
		assigned: number;
		unchanged: number;
		missing: number;
		ownerName: string | null;
		previous: Record<string, string | null>;
	}

	/** The action takes 100 contacts per call; a bigger selection goes in rounds. */
	const PER_CALL = 100;
	async function assign(list: string[], ownerUid: string | null) {
		const out: Result = { assigned: 0, unchanged: 0, missing: 0, ownerName: null, previous: {} };
		for (let i = 0; i < list.length; i += PER_CALL) {
			const r = await callAction<Result>('crm:contact.assignMany', {
				ids: list.slice(i, i + PER_CALL),
				ownerUid
			});
			out.assigned += r.assigned;
			out.unchanged += r.unchanged;
			out.missing += r.missing;
			out.ownerName = r.ownerName;
			Object.assign(out.previous, r.previous);
		}
		return out;
	}

	// The team, read once when the bar first shows (one read per person).
	let team = $state<TeamUser[] | null>(null);
	$effect(() => {
		if (!ids.length || team) return;
		getDocs(query(collection(db, 'user'), where('role', 'in', ['user', 'admin']), limit(200)))
			.then((s) => {
				team = s.docs
					.map((d) => ({ id: d.id, ...(d.data() as Omit<TeamUser, 'id'>) }))
					.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
			})
			.catch((e) => onerror(errorText(e)));
	});

	let busy = $state(false);
	let picked = $state('');
	/** The last bulk assignment, with what Undo puts back (cleared after 15 seconds). */
	let notice = $state<{ text: string; previous: Record<string, string | null> } | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	function show(n: typeof notice) {
		clearTimeout(timer);
		notice = n;
		if (n) timer = setTimeout(() => (notice = null), 15_000);
	}
	$effect(() => () => clearTimeout(timer));

	const plural = (n: number) => `${n} contact${n === 1 ? '' : 's'}`;

	async function run(value: string) {
		if (!value) return;
		// "none" is the "No owner" option; any other value is a user id.
		const ownerUid = value === 'none' ? null : value;
		busy = true;
		onerror(null);
		try {
			const r = await assign(ids, ownerUid);
			const extra = r.unchanged ? ` (${r.unchanged} already had that owner)` : '';
			let text = `Nothing changed: ${plural(r.unchanged)} already had that owner`;
			if (r.assigned && r.ownerName)
				text = `Assigned ${plural(r.assigned)} to ${r.ownerName}${extra}`;
			else if (r.assigned) text = `Unassigned ${plural(r.assigned)}${extra}`;
			show({ text, previous: r.previous });
			onclear();
		} catch (e) {
			onerror(errorText(e));
		} finally {
			busy = false;
			picked = '';
		}
	}

	/** Each contact back to its previous owner: one call per previous owner. */
	async function undo() {
		const n = notice;
		// The notice goes first, so a second click can't undo twice.
		show(null);
		if (!n) return;
		// Keyed by owner id; '' = no owner.
		const byOwner: Record<string, string[]> = {};
		for (const [id, owner] of Object.entries(n.previous)) (byOwner[owner ?? ''] ??= []).push(id);
		busy = true;
		onerror(null);
		try {
			for (const [owner, list] of Object.entries(byOwner)) await assign(list, owner || null);
		} catch (e) {
			onerror(errorText(e));
		} finally {
			busy = false;
		}
	}
</script>

{#if ids.length}
	<div
		class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-primary-200 bg-primary-50 px-3 py-2 text-sm"
		role="region"
		aria-label="Selected contacts"
	>
		<span class="font-semibold whitespace-nowrap">{ids.length} selected</span>
		<span class="text-ink-soft">·</span>
		<select
			class="input w-auto min-w-0 py-1 pr-8"
			aria-label="Assign the selected contacts to"
			disabled={busy || !team}
			bind:value={picked}
			onchange={() => run(picked)}
		>
			<option value="">{team ? 'Assign to …' : 'Loading the team…'}</option>
			<option value="none">No owner</option>
			{#each team ?? [] as u (u.id)}
				<option value={u.id}>{u.name || u.email}</option>
			{/each}
		</select>
		{#if busy}<span class="text-xs text-ink-soft">Saving…</span>{/if}
		<span class="text-ink-soft">·</span>
		<button
			class="font-semibold text-primary-700 hover:underline"
			disabled={busy}
			onclick={onclear}
		>
			Clear
		</button>
	</div>
{/if}

{#if notice}
	<div
		class="flex w-fit max-w-full items-center gap-2 rounded-md bg-primary-50 px-3 py-1.5 text-sm"
		role="status"
	>
		<span class="min-w-0">{notice.text}</span>
		{#if Object.keys(notice.previous).length}
			<span class="text-ink-soft">·</span>
			<button class="font-semibold text-primary-700 hover:underline" onclick={undo}>Undo</button>
		{/if}
	</div>
{/if}
