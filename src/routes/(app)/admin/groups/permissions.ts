import { callAction } from '$lib/actions';

/** One permission as functions/src/lib/permissions.ts describes it (`PERMISSION_CATALOG`). */
export interface PermissionInfo {
	id: string;
	app: string;
	label: string;
	help: string;
	/** Read access that opens the app. */
	opens?: boolean;
	/** Being an admin doesn't grant it. */
	adminsNeedIt?: boolean;
}

/**
 * The permission list with labels, from `core:config.get` (admins only). Until the backend
 * sends `catalog`, each permission is shown by its id.
 */
export async function loadPermissions(): Promise<PermissionInfo[]> {
	const r = await callAction<{ permissions: string[]; catalog?: PermissionInfo[] }>(
		'core:config.get'
	);
	return (
		r.catalog ??
		r.permissions.map((id) => ({
			id,
			app: id.split('.')[0],
			label: id,
			help: '',
			opens: /\.(read|connect)$/.test(id)
		}))
	);
}

/** The apps a person can open, from their role and their groups' permissions. */
export function appsOf(
	role: string,
	granted: Set<string>,
	catalog: PermissionInfo[]
): { all: boolean; apps: string[] } {
	if (role === 'guest') return { all: false, apps: [] };
	const apps = catalog
		.filter((p) => p.opens && (granted.has(p.id) || (role === 'admin' && !p.adminsNeedIt)))
		.map((p) => p.app);
	return { all: role === 'admin', apps: [...new Set(apps)] };
}
