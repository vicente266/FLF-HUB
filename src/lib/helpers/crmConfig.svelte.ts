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

export function stageLabel(c: CrmConfig | null, type: ContactType, stage: string): string {
	return c?.pipelines[type]?.stages.find((s) => s.id === stage)?.label ?? stage;
}

export const TYPE_STYLE: Record<ContactType, string> = {
	fellow: 'bg-primary-50 text-primary-700',
	guru: 'bg-amber-50 text-amber-800',
	investor: 'bg-sky-50 text-sky-800'
};
