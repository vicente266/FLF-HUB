<script lang="ts">
	import type { Level } from '$lib/types/connections';

	let { level, label }: { level: Level; label?: string } = $props();

	const COLOR: Record<Level, string> = {
		ok: 'bg-success',
		warning: 'bg-warning',
		error: 'bg-danger',
		off: 'bg-line'
	};
</script>

<span class="inline-flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap">
	<span class="h-2 w-2 shrink-0 rounded-full {COLOR[level]}"></span>
	{#if label}{label}{/if}
</span>
