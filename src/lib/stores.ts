import { writable } from 'svelte/store';

export interface Me {
	uid: string;
	email: string;
	name: string;
	role: 'guest' | 'user' | 'admin';
	permissions: string[];
}

/** The signed-in user, set by the (app) layout once `core:user.validate` answers. */
export const me = writable<Me | null>(null);

/** Title shown in the header. Pages set it with `setTitle`. */
export const pageTitle = writable<{ title: string; subtitle?: string }>({ title: '' });
