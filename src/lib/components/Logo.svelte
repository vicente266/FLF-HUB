<script lang="ts">
	let { size = 'md' }: { size?: 'md' | 'lg' } = $props();
</script>

<!-- The website's navy tile with the teal summit -->
<svg
	viewBox="0 0 64 64"
	class={size === 'lg' ? 'h-16 w-16' : 'h-8 w-8'}
	role="img"
	aria-label="Founders for Life Fellowship"
>
	<rect width="64" height="64" rx="14" fill="var(--color-navy)" />
	<path
		d="M20 44 32 18l12 26"
		fill="none"
		stroke="var(--color-primary-500)"
		stroke-width="4.5"
		stroke-linecap="round"
		stroke-linejoin="round"
	/>
	<path
		d="M26 44 32 31l6 13"
		fill="none"
		stroke="var(--color-primary-500)"
		stroke-width="3"
		stroke-linecap="round"
		stroke-linejoin="round"
		opacity=".55"
	/>
</svg>
