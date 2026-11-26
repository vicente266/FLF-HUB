import type { Component } from 'svelte';
import LayoutDashboard from '@lucide/svelte/icons/layout-dashboard';
import Users from '@lucide/svelte/icons/users';
import ListChecks from '@lucide/svelte/icons/list-checks';
import CalendarDays from '@lucide/svelte/icons/calendar-days';
import BookOpen from '@lucide/svelte/icons/book-open';
import Target from '@lucide/svelte/icons/target';
import ChartColumn from '@lucide/svelte/icons/chart-column';
import Workflow from '@lucide/svelte/icons/workflow';
import Plug from '@lucide/svelte/icons/plug';
import HeartPulse from '@lucide/svelte/icons/heart-pulse';
import UserCog from '@lucide/svelte/icons/user-cog';
import Shield from '@lucide/svelte/icons/shield';
import Sparkles from '@lucide/svelte/icons/sparkles';
import Clapperboard from '@lucide/svelte/icons/clapperboard';
import WandSparkles from '@lucide/svelte/icons/wand-sparkles';

export interface NavItem {
	href: string;
	label: string;
	icon: Component;
	/** Permission expression for `hasPermission`; omitted = everyone on the team. */
	permission?: string;
	adminOnly?: boolean;
}

export interface NavSection {
	label: string;
	items: NavItem[];
}

export const NAVIGATION: NavSection[] = [
	{
		label: 'Work',
		items: [
			{ href: '/', label: 'Home', icon: LayoutDashboard },
			{ href: '/crm', label: 'CRM', icon: Users, permission: 'crm.any.read' },
			{ href: '/tasks', label: 'Tasks', icon: ListChecks, permission: 'crm.any.read' },
			{ href: '/events', label: 'Events', icon: CalendarDays, permission: 'crm.any.read' },
			{ href: '/gtm', label: 'Go-to-market', icon: Target, permission: 'crm.any.read' },
			{ href: '/reports', label: 'Reports', icon: ChartColumn, permission: 'reports.any.read' },
			{ href: '/tv', label: 'FLF TV', icon: Clapperboard, permission: 'tv.any.read' },
			{
				href: '/knowledge',
				label: 'Knowledge',
				icon: BookOpen,
				permission: 'knowledge.any.read'
			},
			{ href: '/skills', label: 'Skills', icon: WandSparkles, permission: 'skills.any.read' }
		]
	},
	{
		label: 'Engine',
		items: [
			{
				href: '/automations',
				label: 'Automations',
				icon: Workflow,
				permission: 'automations.any.read'
			},
			{
				href: '/connections',
				label: 'Connections',
				icon: Plug,
				permission: 'connections.any.read'
			},
			{ href: '/health', label: 'Health', icon: HeartPulse, permission: 'health.any.read' },
			{ href: '/claude', label: 'Claude', icon: Sparkles }
		]
	},
	{
		label: 'Admin',
		items: [
			{ href: '/admin/users', label: 'Users', icon: UserCog, adminOnly: true },
			{ href: '/admin/groups', label: 'Groups', icon: Shield, adminOnly: true }
		]
	}
];
