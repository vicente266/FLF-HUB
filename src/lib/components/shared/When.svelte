<script lang="ts">
	import { formatDateTime, relative, toDate } from '$lib/utils';

	/** "5 minutes ago", with the exact date and time on hover. */
	let { value, fallback = '—' }: { value: unknown; fallback?: string } = $props();

	let date = $derived(toDate(value));
</script>

{#if date}
	<time datetime={date.toISOString()} title={formatDateTime(date)}>{relative(date)}</time>
{:else}
	{fallback}
{/if}
