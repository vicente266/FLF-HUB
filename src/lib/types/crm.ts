/** Shapes returned by `crm:config.get` and stored in `contact`, `task`. */

export type ContactType = 'fellow' | 'guru' | 'investor';

export interface Stage {
	id: string;
	label: string;
	final?: boolean;
	followUpDays?: number;
	followUp?: string;
}

export interface Pipeline {
	label: string;
	plural: string;
	description: string;
	stages: Stage[];
}

export interface CrmConfig {
	types: ContactType[];
	sources: string[];
	pipelines: Record<ContactType, Pipeline>;
	staleDays: number;
}

export interface Contact {
	id: string;
	type: ContactType;
	name: string;
	email: string;
	phone: string;
	company: string;
	linkedin: string;
	source: string;
	stage: string;
	open: boolean;
	ownerUid: string | null;
	ownerName: string | null;
	tags: string[];
	notes: string;
	needsAttention: boolean;
	stageChangedAt: unknown;
	lastActivityAt: unknown;
	createdAt: unknown;
}

export interface Activity {
	id: string;
	kind: 'created' | 'note' | 'stage' | 'assigned' | 'automation' | 'updated';
	text: string;
	by: string;
	at: unknown;
}

export interface Task {
	id: string;
	contactId: string;
	contactName: string;
	title: string;
	dueAt: unknown;
	assigneeUid: string;
	done: boolean;
	source: 'automation' | 'manual' | 'claude';
}

export interface TeamUser {
	id: string;
	email: string;
	name?: string;
	role: 'guest' | 'user' | 'admin';
	groups: string[];
	sherpa?: boolean;
	createdAt?: unknown;
}

export interface Group {
	id: string;
	name: string;
	description?: string;
	permissions: string[];
}

/** The contact form's fields; `tags` is the comma-separated text. */
export interface ContactDraft {
	type: ContactType;
	name: string;
	email: string;
	phone: string;
	company: string;
	linkedin: string;
	source: string;
	tags: string;
	notes: string;
}
