export type Category = 'inbound' | 'data' | 'messaging' | 'platform' | 'ai';

export interface SettingField {
	key: string;
	label: string;
	help: string;
	kind: 'text' | 'list';
}

export interface Connector {
	id: string;
	name: string;
	category: Category;
	availability: 'live' | 'planned';
	description: string;
	feeds: string[];
	secrets: string[];
	settings: SettingField[];
	setup: string[];
	testable: boolean;
}

export type Status = 'ok' | 'error' | 'not_configured' | 'planned' | 'not_checked';

export interface ConnectionState {
	id: string;
	settings?: Record<string, string>;
	status?: Status;
	detail?: string;
	lastCheckAt?: unknown;
	lastError?: string | null;
	lastEventAt?: unknown;
	lastSyncAt?: unknown;
}

export interface AutomationDef {
	id: string;
	name: string;
	description: string;
	trigger: 'contact.stage' | 'contact.nextStep' | 'meeting' | 'schedule';
	schedule?: string;
	uses: string[];
	defaultEnabled: boolean;
}

export type Level = 'ok' | 'warning' | 'error' | 'off';

export interface Health {
	overall: Level;
	connections: {
		id: string;
		name: string;
		availability: 'live' | 'planned';
		level: Level;
		status: Status;
		detail: string;
		lastCheckAt: number | null;
		lastEventAt: number | null;
		lastSyncAt: number | null;
	}[];
	automations: {
		id: string;
		name: string;
		enabled: boolean;
		level: Level;
		lastRunAt: number | null;
		lastError: string | null;
		runs: number;
		errors: number;
	}[];
}
