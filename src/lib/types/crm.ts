/** Shapes returned by `crm:config.get` and stored in `contact`, `task`. */

/** A contact type id from `crm:config.get` (defined in functions/src/lib/crm/config.ts). */
export type ContactType = string;

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
	/** The sheet's Status values; setting one gives the owner a task. */
	nextSteps: { id: string; label: string; task: string; days: number }[];
	/** Kinds of Partner organisation (VC fund, university…). */
	segments: { id: string; label: string }[];
	strategyStatuses: string[];
}

/** A go-to-market strategy; Partners link to it with `strategyId`. */
export interface Strategy {
	id: string;
	name: string;
	segment: string;
	status: 'active' | 'paused' | 'done';
	description: string;
	updatedBy?: string;
	updatedAt?: unknown;
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
	nextStep?: string;
	/** Partners: kind of organisation and go-to-market strategy. */
	segment?: string;
	strategyId?: string;
	/** The portal sheet's view, when the contact was imported from it. */
	portal?: {
		from: string;
		cohort: string | null;
		pledgeSigned: boolean | null;
		pledgeDate: unknown;
		companyUrl: string | null;
		location: string | null;
		sherpaName: string | null;
		archetype: string | null;
		funnelStage: string | null;
		/** Profiles: can sign in to the portal ("Show in portal"). */
		onPortal?: boolean | null;
		/** Profiles: link to the signed Founder's Pledge. */
		contractUrl?: string | null;
		reasonsWhy?: string | null;
		lastInteraction?: unknown;
		nextStep: string | null;
		scoring: string | null;
		reasonLost: string | null;
		sheetNotes: string | null;
		syncedAt: unknown;
	};
	stageChangedAt: unknown;
	lastActivityAt: unknown;
	createdAt: unknown;
}

export interface Activity {
	id: string;
	kind: 'created' | 'note' | 'stage' | 'assigned' | 'automation' | 'updated' | 'meeting';
	text: string;
	by: string;
	at: unknown;
}

export interface Task {
	id: string;
	/** Null for team tasks imported from the portal sheet. */
	contactId: string | null;
	contactName: string | null;
	ownerName?: string;
	title: string;
	dueAt: unknown;
	assigneeUid: string;
	done: boolean;
	source: 'automation' | 'manual' | 'claude' | 'portal';
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
	segment?: string;
	strategyId?: string;
}

/** A meeting from the portal sheet's Events tab (n8n's "Calendar → Events database"). */
export interface CalendarEvent {
	id: string;
	title: string;
	type: string;
	date: unknown;
	description: string;
	showInPortal: boolean;
	participants: { name: string; contactId: string | null }[];
	contactIds: string[];
}
