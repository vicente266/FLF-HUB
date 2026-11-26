<script lang="ts">
	import type { SkillIssue } from '$lib/types/skills';

	// A skill's audit as red (error) and amber (warning) chips, errors first. Two show; the rest
	// open on "+N more". Each chip's full message is on hover and in the open list.
	let { issues }: { issues: SkillIssue[] } = $props();

	let open = $state(false);
	let sorted = $derived(
		[...issues].sort((a, b) => Number(b.level === 'error') - Number(a.level === 'error'))
	);
	const TONE = {
		error: 'bg-danger/10 text-danger',
		warning: 'bg-warning/10 text-warning'
	} as const;
</script>

{#if !issues.length}
	<span class="text-xs font-semibold text-success">No issues</span>
{:else if open}
	<ul class="space-y-1">
		{#each sorted as i, n (n)}
			<li class="rounded px-1.5 py-0.5 text-xs {TONE[i.level]}">{i.message}</li>
		{/each}
	</ul>
	<button class="mt-1 text-xs text-ink-soft hover:underline" onclick={() => (open = false)}>
		Show less
	</button>
{:else}
	<div class="flex flex-wrap items-center gap-1">
		{#each sorted.slice(0, 2) as i, n (n)}
			<span
				class="max-w-56 truncate rounded px-1.5 py-0.5 text-xs font-semibold {TONE[i.level]}"
				title={i.message}
			>
				{i.message}
			</span>
		{/each}
		{#if sorted.length > 2}
			<button
				class="text-xs font-semibold text-ink-soft hover:underline"
				title={sorted
					.slice(2)
					.map((i) => i.message)
					.join('\n')}
				onclick={() => (open = true)}
			>
				+{sorted.length - 2} more
			</button>
		{/if}
	</div>
{/if}
