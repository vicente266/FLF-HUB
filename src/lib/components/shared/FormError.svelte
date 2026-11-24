<script lang="ts">
	let { message }: { message: string | null } = $props();
</script>

{#if message}
	<div class="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
		{message}
	</div>
{/if}
