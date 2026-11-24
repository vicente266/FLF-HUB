import admin from 'firebase-admin';
import { HttpsError } from 'firebase-functions/v2/https';
import * as user from './user';
import { callContext } from './call-context';

/**
 * Admins pass every check; everyone else needs the permission through one of their groups. Inside a
 * connector call, the role and permissions it already read are used instead of reading them again.
 */
export const hasPermission = async (auth: any, permission: string): Promise<boolean> => {
	const ctx = callContext();
	if (ctx && ctx.uid === auth?.uid) {
		return ctx.role === 'admin' || ctx.permissions.includes(permission);
	}
	if (auth?.token?.role === 'admin') return true;
	return user.hasPermission(auth.uid, permission);
};

export const serverTimestamp = () => admin.firestore.FieldValue.serverTimestamp();
export const increment = (n: number) => admin.firestore.FieldValue.increment(n);
export const Timestamp = admin.firestore.Timestamp;

/** A trimmed string from a payload field, or a 400 when it is required and missing. */
export function str(value: unknown, field: string, required = true): string {
	const s = typeof value === 'string' ? value.trim() : '';
	if (required && !s) throw new HttpsError('invalid-argument', `Missing ${field}.`);
	return s;
}

/** A value from a fixed list, or a 400. */
export function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
	if (typeof value === 'string' && (allowed as readonly string[]).includes(value))
		return value as T;
	throw new HttpsError('invalid-argument', `Invalid ${field}.`);
}

export type LogLevel = 'log' | 'warn' | 'error';

/** Feature-scoped console logger. All lines carry a `[feature]` prefix. */
export interface Logger {
	log(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
	scope(name: string): Logger;
}

export function createLogger(feature: string): Logger {
	const prefix = `[${feature}]`;
	const emit = (level: LogLevel, message: string, args: unknown[]) =>
		// The one place console is allowed: everything else goes through this.
		// eslint-disable-next-line no-console
		console[level](`${prefix} ${message}`, ...args);
	return {
		log: (m, ...a) => emit('log', m, a),
		warn: (m, ...a) => emit('warn', m, a),
		error: (m, ...a) => emit('error', m, a),
		scope: (name) => createLogger(`${feature}:${name}`)
	};
}
