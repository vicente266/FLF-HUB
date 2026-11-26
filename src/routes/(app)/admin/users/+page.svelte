<script lang="ts">
	import { onMount } from 'svelte';
	import { collection, query, orderBy, limit } from 'firebase/firestore';
	import { db } from '$lib/firebase';
	import { callAction, errorText } from '$lib/actions';
	import { listen, setTitle, formatDate } from '$lib/utils';
	import type { Group, TeamUser } from '$lib/types/crm';
	import FormError from '$lib/components/shared/FormError.svelte';
	import Modal from '$lib/components/shared/Modal.svelte';
	import { appsOf, loadPermissions, type PermissionInfo } from '../groups/permissions';

	setTitle('Users', 'Who can sign in, what they can do, and who is a Sherpa');

	let users = $state<TeamUser[]>([]);
	let groups = $state<Group[]>([]);
	let catalog = $state<PermissionInfo[]>([]);
	let error = $state<string | null>(null);
	let saving = $state<string | null>(null);

	onMount(() => {
		loadPermissions()
			.then((c) => (catalog = c))
			.catch((e) => (error = errorText(e)));
		const unsubs = [
			listen<TeamUser>(
				query(collection(db, 'user'), orderBy('createdAt', 'desc'), limit(500)),
				(r) => (users = r)
			),
			listen<Group>(query(collection(db, 'group'), orderBy('name')), (r) => (groups = r))
		];
		return () => unsubs.forEach((u) => u());
	});

	/** Saves the change; returns the error, or null. */
	async function update(u: TeamUser, patch: Partial<TeamUser>): Promise<string | null> {
		saving = u.id;
		const next = { ...u, ...patch };
		try {
			await callAction('core:user.update', {
				uid: u.id,
				role: next.role,
				groups: next.groups ?? [],
				sherpa: next.sherpa === true
			});
			return null;
		} catch (e) {
			return errorText(e);
		} finally {
			saving = null;
		}
	}
	const change = async (u: TeamUser, patch: Partial<TeamUser>) => {
		error = await update(u, patch);
	};

	function toggleGroup(u: TeamUser, id: string) {
		const has = (u.groups ?? []).includes(id);
		change(u, { groups: has ? u.groups.filter((g) => g !== id) : [...(u.groups ?? []), id] });
	}

	// Less access is asked first; the select shows the stored role until it is confirmed.
	const RANK = { guest: 0, user: 1, admin: 2 } as const;
	const firstName = (u: TeamUser) => (u.name || u.email).split(/[\s@]/)[0];
	let downgrade = $state<{ user: TeamUser; role: TeamUser['role'] } | null>(null);
	let downgradeOpen = $state(false);
	let downgradeError = $state<string | null>(null);
	function pickRole(u: TeamUser, el: HTMLSelectElement) {
		const role = el.value as TeamUser['role'];
		if (RANK[role] < RANK[u.role]) {
			el.value = u.role;
			downgrade = { user: u, role };
			downgradeError = null;
			downgradeOpen = true;
			return;
		}
		change(u, { role });
	}
	async function confirmDowngrade() {
		if (!downgrade) return;
		downgradeError = await update(downgrade.user, { role: downgrade.role });
		if (!downgradeError) downgradeOpen = false;
	}
	function downgradeTitle(d: NonNullable<typeof downgrade>): string {
		if (d.user.role === 'admin') return `Remove ${firstName(d.user)}'s admin access?`;
		return `Remove ${firstName(d.user)}'s access to the Hub?`;
	}

	/** "Can see: CRM, Reports, Wellbeing…" from the person's role and groups. */
	function canSee(u: TeamUser): string {
		if (u.role === 'guest') return 'Can’t use the Hub until you make them a user.';
		const granted = new Set(
			groups.filter((g) => (u.groups ?? []).includes(g.id)).flatMap((g) => g.permissions)
		);
		const { all, apps } = appsOf(u.role, granted, catalog);
		if (all) {
			const missing = [
				...new Set(
					catalog.filter((p) => p.opens && p.adminsNeedIt && !granted.has(p.id)).map((p) => p.app)
				)
			];
			return missing.length
				? `Can see: everything except ${missing.join(', ')} (admins need a group for those).`
				: 'Can see: everything.';
		}
		return apps.length ? `Can see: ${apps.join(', ')}.` : 'Can see: nothing yet (add a group).';
	}
</script>

<div class="mx-auto max-w-6xl space-y-3">
	<p class="text-sm text-ink-soft">
		People appear here after their first sign-in. <strong>Guests</strong> cannot use the Hub until you
		make them users. A Fellow's Sherpa in the portal sheet becomes their owner here.
	</p>
	<FormError message={error} />
	<div class="overflow-hidden card">
		<table class="w-full text-sm">
			<thead class="bg-canvas text-left text-xs text-ink-soft">
				<tr>
					<th class="px-4 py-2 font-semibold">User</th>
					<th class="px-4 py-2 font-semibold">Role</th>
					<th class="px-4 py-2 font-semibold">Sherpa</th>
					<th class="px-4 py-2 font-semibold">Groups</th>
					<th class="px-4 py-2 font-semibold">Since</th>
				</tr>
			</thead>
			<tbody class="divide-y divide-line/40">
				{#each users as u (u.id)}
					<tr class="align-top {saving === u.id ? 'opacity-60' : ''}">
						<td class="px-4 py-2">
							<div class="font-semibold">{u.name || u.email}</div>
							{#if u.name}<div class="text-xs text-ink-soft">{u.email}</div>{/if}
						</td>
						<td class="px-4 py-2">
							<select
								class="input w-28 py-1"
								aria-label="Role of {u.name || u.email}"
								value={u.role}
								onchange={(e) => pickRole(u, e.currentTarget)}
							>
								<option value="guest">Guest</option>
								<option value="user">User</option>
								<option value="admin">Admin</option>
							</select>
						</td>
						<td class="px-4 py-2">
							<input
								type="checkbox"
								class="rounded text-primary-600"
								aria-label="Sherpa"
								checked={u.sherpa === true}
								onchange={(e) => change(u, { sherpa: e.currentTarget.checked })}
							/>
						</td>
						<td class="px-4 py-2">
							<div class="flex flex-wrap gap-1">
								{#each groups as g (g.id)}
									<button
										class="rounded-md px-2 py-0.5 text-xs font-semibold {(u.groups ?? []).includes(
											g.id
										)
											? 'bg-primary-600 text-white'
											: 'bg-canvas text-ink-soft hover:bg-primary-50'}"
										aria-pressed={(u.groups ?? []).includes(g.id)}
										onclick={() => toggleGroup(u, g.id)}
									>
										{g.name}
									</button>
								{/each}
							</div>
							{#if catalog.length}<p class="mt-1 text-xs text-ink-soft">{canSee(u)}</p>{/if}
						</td>
						<td class="px-4 py-2 text-xs text-ink-soft">{formatDate(u.createdAt)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>

<Modal
	bind:open={downgradeOpen}
	title={downgrade ? downgradeTitle(downgrade) : ''}
	width="max-w-md"
>
	{#if downgrade}
		<p class="text-sm">
			{#if downgrade.role === 'guest'}
				They can't use the Hub until someone makes them a user again.
			{:else}
				They keep what their groups allow, and lose everything else an admin can do.
			{/if}
			Their Claude connections end straight away.
		</p>
		{#if downgradeError}<div class="mt-3"><FormError message={downgradeError} /></div>{/if}
	{/if}
	{#snippet footer()}
		<button class="btn-ghost" onclick={() => (downgradeOpen = false)}>Cancel</button>
		<button class="btn-primary" disabled={saving !== null} onclick={confirmDowngrade}>
			Remove access
		</button>
	{/snippet}
</Modal>
