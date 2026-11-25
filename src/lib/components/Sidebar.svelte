<script lang="ts">
	import { page } from '$app/state';
	import { me } from '$lib/stores';
	import { hasPermission } from '$lib/utils';
	import { NAVIGATION, type NavItem } from '$lib/config/navigation';
	import Logo from './Logo.svelte';

	const visible = (item: NavItem) => {
		if (!$me) return false;
		if (item.adminOnly) return $me.role === 'admin';
		return !item.permission || hasPermission(item.permission);
	};

	const active = (href: string) =>
		href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href);

	let sections = $derived(
		NAVIGATION.map((s) => ({ ...s, items: s.items.filter(visible) })).filter((s) => s.items.length)
	);
</script>

<a href="/" class="flex items-center gap-2.5 px-2 pt-4 pb-2">
	<Logo />
	<div class="leading-tight">
		<div class="text-sm font-bold text-ink">FLF Hub</div>
		<div class="text-[10px] font-semibold text-primary-600">Founders for Life Fellowship</div>
	</div>
</a>

<nav class="flex flex-1 flex-col gap-5">
	{#each sections as section (section.label)}
		<div>
			<div class="mb-1 px-2 text-[10px] font-bold tracking-[0.14em] text-ink-soft/60 uppercase">
				{section.label}
			</div>
			<ul class="space-y-0.5">
				{#each section.items as item (item.href)}
					<li>
						<a
							href={item.href}
							class="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm font-medium {active(
								item.href
							)
								? 'bg-primary-50 text-primary-700'
								: 'text-ink-soft hover:bg-canvas hover:text-ink'}"
						>
							<item.icon class="h-4 w-4 shrink-0" />
							{item.label}
						</a>
					</li>
				{/each}
			</ul>
		</div>
	{/each}
</nav>
