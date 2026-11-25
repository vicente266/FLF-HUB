import { callAction } from '$lib/actions';
import type { CrmConfig, ContactType } from '$lib/types/crm';

/** The CRM config, fetched once per session from `crm:config.get`. */
let config = $state<CrmConfig | null>(null);
let loading: Promise<CrmConfig> | null = null;

export function crmConfig() {
	if (!config && !loading) {
		loading = callAction<CrmConfig>('crm:config.get').then((c) => (config = c));
	}
	return {
		get value() {
			return config;
		}
	};
}

/**
 * How a contact is titled: a Partner by its organisation (company), with the main contact below;
 * everyone else by name, with the company below.
 */
export function contactTitle(c: { type: string; name: string; company?: string }) {
	return c.type === 'partner' ? c.company || c.name : c.name;
}
export function contactSubtitle(c: { type: string; name: string; company?: string }) {
	if (c.type !== 'partner') return c.company ?? '';
	return c.company ? c.name : '';
}

export function stageLabel(c: CrmConfig | null, type: ContactType, stage: string): string {
	return c?.pipelines[type]?.stages.find((s) => s.id === stage)?.label ?? stage;
}

/** Badge colours, given out in the order of `config.types`. */
const TYPE_STYLES = [
	'bg-primary-50 text-primary-700',
	'bg-amber-50 text-amber-800',
	'bg-sky-50 text-sky-800',
	'bg-canvas text-ink-soft'
];

export function typeStyle(c: CrmConfig | null, type: ContactType): string {
	const i = c?.types.indexOf(type) ?? -1;
	return TYPE_STYLES[i >= 0 && i < TYPE_STYLES.length ? i : TYPE_STYLES.length - 1];
}
