<script lang="ts">
	import type { Snippet } from 'svelte';
	import X from '@lucide/svelte/icons/x';

	let {
		open = $bindable(false),
		title,
		width = 'max-w-lg',
		children,
		footer
	}: {
		open: boolean;
		title: string;
		width?: string;
		children: Snippet;
		footer?: Snippet;
	} = $props();

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') open = false;
	}
</script>

<svelte:window {onkeydown} />

{#if open}
	<div class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-navy/40 p-8">
		<button class="fixed inset-0 cursor-default" aria-label="Close" onclick={() => (open = false)}
		></button>
		<div class="relative w-full card {width} shadow-xl">
			<div class="flex items-center justify-between border-b border-line/60 px-5 py-3">
				<h2 class="font-bold">{title}</h2>
				<button class="text-ink-soft hover:text-ink" onclick={() => (open = false)}>
					<X class="h-4 w-4" />
				</button>
			</div>
			<div class="px-5 py-4">{@render children()}</div>
			{#if footer}
				<div class="flex justify-end gap-2 border-t border-line/60 px-5 py-3">
					{@render footer()}
				</div>
			{/if}
		</div>
	</div>
{/if}
