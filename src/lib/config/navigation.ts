import type { Component } from 'svelte';
import LayoutDashboard from '@lucide/svelte/icons/layout-dashboard';
import Users from '@lucide/svelte/icons/users';
import ListChecks from '@lucide/svelte/icons/list-checks';
import ChartColumn from '@lucide/svelte/icons/chart-column';
import Workflow from '@lucide/svelte/icons/workflow';
import Plug from '@lucide/svelte/icons/plug';
import HeartPulse from '@lucide/svelte/icons/heart-pulse';
import UserCog from '@lucide/svelte/icons/user-cog';
import Shield from '@lucide/svelte/icons/shield';

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
			{ href: '/reports', label: 'Reports', icon: ChartColumn, permission: 'reports.any.read' }
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
			{ href: '/health', label: 'Health', icon: HeartPulse, permission: 'health.any.read' }
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
