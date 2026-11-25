<script lang="ts">
	import { onMount } from 'svelte';
	import { collection, query, orderBy, limit } from 'firebase/firestore';
	import { db } from '$lib/firebase';
	import { callAction, errorText } from '$lib/actions';
	import { listen, setTitle, formatDate } from '$lib/utils';
	import type { Group, TeamUser } from '$lib/types/crm';
	import FormError from '$lib/components/shared/FormError.svelte';

	setTitle('Users', 'Who can sign in, what they can do, and who is a Sherpa');

	let users = $state<TeamUser[]>([]);
	let groups = $state<Group[]>([]);
	let error = $state<string | null>(null);
	let saving = $state<string | null>(null);

	onMount(() => {
		const unsubs = [
			listen<TeamUser>(
				query(collection(db, 'user'), orderBy('createdAt', 'desc'), limit(500)),
				(r) => (users = r)
			),
			listen<Group>(query(collection(db, 'group'), orderBy('name')), (r) => (groups = r))
		];
		return () => unsubs.forEach((u) => u());
	});

	async function update(u: TeamUser, patch: Partial<TeamUser>) {
		saving = u.id;
		error = null;
		const next = { ...u, ...patch };
		try {
			await callAction('core:user.update', {
				uid: u.id,
				role: next.role,
				groups: next.groups ?? [],
				sherpa: next.sherpa === true
			});
		} catch (e) {
			error = errorText(e);
		} finally {
			saving = null;
		}
	}

	function toggleGroup(u: TeamUser, id: string) {
		const has = (u.groups ?? []).includes(id);
		update(u, { groups: has ? u.groups.filter((g) => g !== id) : [...(u.groups ?? []), id] });
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
					<tr class={saving === u.id ? 'opacity-60' : ''}>
						<td class="px-4 py-2">
							<div class="font-semibold">{u.name || u.email}</div>
							{#if u.name}<div class="text-xs text-ink-soft">{u.email}</div>{/if}
						</td>
						<td class="px-4 py-2">
							<select
								class="input w-28 py-1"
								value={u.role}
								onchange={(e) => update(u, { role: e.currentTarget.value as TeamUser['role'] })}
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
								checked={u.sherpa === true}
								onchange={(e) => update(u, { sherpa: e.currentTarget.checked })}
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
										onclick={() => toggleGroup(u, g.id)}
									>
										{g.name}
									</button>
								{/each}
							</div>
						</td>
						<td class="px-4 py-2 text-xs text-ink-soft">{formatDate(u.createdAt)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>
