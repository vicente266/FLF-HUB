/**
 * Fill the local emulators with an admin, a teammate, groups and sample contacts.
 * Emulator-only and idempotent. Run with the emulators up:  node scripts/seed-emulator.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(new URL('../functions/package.json', import.meta.url));
const admin = require('firebase-admin');

process.env.FIRESTORE_EMULATOR_HOST ??= 'localhost:8081';
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= 'localhost:9099';
admin.initializeApp({ projectId: 'flf-hub' });
const db = admin.firestore();
const auth = admin.auth();
const DAY = 86_400_000;
const ago = (days) => admin.firestore.Timestamp.fromMillis(Date.now() - days * DAY);

const GROUPS = {
	default: {
		name: 'Default',
		description: 'Everyone who signs in.',
		permissions: ['crm.any.read', 'health.any.read']
	},
	sherpas: {
		name: 'Sherpas',
		description: 'Run the pipeline day to day.',
		permissions: [
			'crm.any.read',
			'crm.any.write',
			'tasks.self.read',
			'reports.any.read',
			'automations.any.read',
			'connections.any.read',
			'health.any.read'
		]
	},
	ops: {
		name: 'Operations',
		description: 'Owns automations and connections.',
		permissions: [
			'crm.any.read',
			'crm.any.write',
			'crm.any.delete',
			'reports.any.read',
			'automations.any.read',
			'automations.any.write',
			'connections.any.read',
			'connections.any.write',
			'health.any.read',
			'claude.self.connect'
		]
	}
};

async function user(email, name, role, groups, sherpa) {
	let u;
	try {
		u = await auth.getUserByEmail(email);
	} catch {
		u = await auth.createUser({ email, password: 'flf-local-123', displayName: name });
	}
	await auth.setCustomUserClaims(u.uid, { role });
	await db
		.doc(`user/${u.uid}`)
		.set({ email, name, role, groups, sherpa, createdAt: ago(30), updatedAt: ago(0) });
	return { uid: u.uid, name };
}

const CONTACTS = [
	['fellow', 'Lucía Martín', 'lucia@nimbuslabs.io', 'Nimbus Labs', 'lead', 'website', 1],
	['fellow', 'Tomás Ribeiro', 'tomas@fieldwise.ai', 'Fieldwise', 'screening', 'referral', 4],
	['fellow', 'Amara Okafor', 'amara@payloop.co', 'Payloop', 'interview', 'event', 9],
	['fellow', 'Jonas Becker', 'jonas@gridly.de', 'Gridly', 'offer', 'referral', 20],
	['fellow', 'Sofía Herrera', 'sofia@kelp.bio', 'Kelp Bio', 'fellow', 'website', 40],
	['fellow', 'Marc Dubois', 'marc@stackr.fr', 'Stackr', 'lead', 'website', 18],
	['guru', 'Elena Vidal', 'elena@growthcraft.com', 'Growthcraft', 'conversation', 'referral', 6],
	['guru', 'Peter Lindqvist', 'peter@exitpath.se', 'ExitPath', 'active', 'event', 60],
	['investor', 'Rachel Kim', 'rachel@northstar.vc', 'Northstar Ventures', 'intro', 'event', 3],
	['investor', 'Diego Alonso', 'diego@kapital.es', 'Kapital Seed', 'roster', 'referral', 50]
];
const STAGES = {
	fellow: ['lead', 'screening', 'interview', 'offer', 'fellow', 'declined'],
	guru: ['prospect', 'conversation', 'onboarding', 'active', 'declined'],
	investor: ['prospect', 'intro', 'engaged', 'roster', 'declined']
};
const FINAL = ['fellow', 'active', 'roster', 'declined'];

for (const [id, g] of Object.entries(GROUPS)) await db.doc(`group/${id}`).set(g);
const me = await user(
	'admin@foundersforlifefellowship.com',
	'Vicente Admin',
	'admin',
	['default', 'ops'],
	true
);
const sherpa = await user(
	'sherpa@foundersforlifefellowship.com',
	'Ana Sherpa',
	'user',
	['default', 'sherpas'],
	true
);
const owners = [me, sherpa];

for (const [i, [type, name, email, company, stage, source, days]] of CONTACTS.entries()) {
	const owner = owners[i % 2];
	const ref = db.doc(`contact/seed-${i}`);
	await db.recursiveDelete(ref);
	await ref.set({
		type,
		name,
		email,
		company,
		stage,
		source,
		phone: '',
		linkedin: '',
		tags: i % 3 === 0 ? ['alpha-cohort'] : [],
		notes: '',
		open: !FINAL.includes(stage),
		ownerUid: owner.uid,
		ownerName: owner.name,
		needsAttention: days > 14 && !FINAL.includes(stage),
		stageChangedAt: ago(Math.min(days, 5)),
		lastActivityAt: ago(days),
		createdAt: ago(days + 3),
		updatedAt: ago(days),
		createdBy: 'seed'
	});
	await ref
		.collection('activity')
		.add({ kind: 'created', text: `Created from ${source}`, by: 'Seed', at: ago(days + 3) });
	if (STAGES[type].indexOf(stage) > 0)
		await ref.collection('activity').add({
			kind: 'stage',
			text: `Moved to ${stage}`,
			by: owner.name,
			at: ago(Math.min(days, 5))
		});
	await ref.collection('activity').add({
		kind: 'note',
		text: 'Intro call: strong founder, clear on the long game.',
		by: owner.name,
		at: ago(days)
	});
	if (!FINAL.includes(stage)) {
		await db.doc(`task/seed-${i}`).set({
			contactId: ref.id,
			contactName: name,
			title: i % 2 ? 'Send interview invite' : 'Reply to application',
			dueAt: admin.firestore.Timestamp.fromMillis(Date.now() + (i - 4) * DAY),
			assigneeUid: owner.uid,
			done: false,
			source: 'automation',
			createdAt: ago(1)
		});
	}
}
console.log('Seeded. Sign in as admin@foundersforlifefellowship.com / flf-local-123');
