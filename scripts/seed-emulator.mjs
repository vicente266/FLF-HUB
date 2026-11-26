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
			'claude.self.connect',
			'wellbeing.any.read',
			'wealth.any.read',
			'tv.any.read',
			'tv.any.write'
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
	['fellow', 'Lucía Martín', 'lucia@nimbuslabs.io', 'Nimbus Labs', 'application', 'website', 1],
	['fellow', 'Tomás Ribeiro', 'tomas@fieldwise.ai', 'Fieldwise', 'target', 'referral', 4],
	['fellow', 'Amara Okafor', 'amara@payloop.co', 'Payloop', 'aware', 'event', 9],
	['fellow', 'Jonas Becker', 'jonas@gridly.de', 'Gridly', 'teaser', 'referral', 20],
	['fellow', 'Sofía Herrera', 'sofia@kelp.bio', 'Kelp Bio', 'fellow', 'website', 40],
	['fellow', 'Marc Dubois', 'marc@stackr.fr', 'Stackr', 'application', 'website', 18],
	['guru', 'Elena Vidal', 'elena@growthcraft.com', 'Growthcraft', 'conversation', 'referral', 6],
	['guru', 'Peter Lindqvist', 'peter@exitpath.se', 'ExitPath', 'active', 'event', 60],
	['investor', 'Rachel Kim', 'rachel@northstar.vc', 'Northstar Ventures', 'intro', 'event', 3],
	['investor', 'Diego Alonso', 'diego@kapital.es', 'Kapital Seed', 'roster', 'referral', 50]
];
const STAGES = {
	fellow: ['application', 'target', 'aware', 'teaser', 'fellow', 'lost'],
	guru: ['prospect', 'conversation', 'onboarding', 'active', 'declined'],
	investor: ['prospect', 'intro', 'engaged', 'roster', 'declined']
};
const FINAL = ['fellow', 'lost', 'active', 'roster', 'declined'];

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
// FLF TV: one processed video with topics and three clips in different states.
await db.doc('tvVideo/tv-demo').set({
	title: 'FLF Podcast #12 — Aleks on the long game',
	driveFileId: 'demo',
	driveUrl: 'https://drive.google.com',
	status: 'review',
	step: null,
	error: null,
	durationSec: 2710,
	clipCount: 3,
	createdBy: 'Vicente Admin',
	createdAt: ago(0),
	topics: [
		{
			start: 0,
			end: 412.5,
			title: 'Why founders quit too early',
			summary: 'The long game and the moment most people give up.'
		},
		{
			start: 413.1,
			end: 1290.4,
			title: 'Selling a company and loneliness',
			summary: 'What the first exit felt like and nobody tells you.'
		},
		{
			start: 1291,
			end: 2710,
			title: 'What a Sherpa is for',
			summary: 'Honest feedback from people who made the climb.'
		}
	]
});
const clipBase = {
	videoId: 'tv-demo',
	videoTitle: 'FLF Podcast #12 — Aleks on the long game',
	focusX: 0.5,
	hashtags: ['#founders', '#longgame'],
	error: null,
	updatedAt: ago(0),
	createdAt: ago(0)
};
await db.doc('tvClip/c0').set({
	...clipBase,
	index: 0,
	start: 88.62,
	end: 141.3,
	hook: 'Most founders quit right before it works',
	title: 'Quit too early',
	caption: 'The long game is the only game. Most people stop one step short.',
	reason: 'Strong opening claim, payoff in the last line.',
	score: 9,
	status: 'rendered',
	startCut: 'silence',
	endCut: 'silence',
	startPause: 0.9,
	endPause: 1.2,
	renderUrl: 'https://drive.google.com',
	coverUrl: 'https://drive.google.com',
	thumbnailUrl: 'https://drive.google.com',
	coverWhy: 'Both hosts laughing, faces sharp.'
});
await db.doc('tvClip/c1').set({
	...clipBase,
	index: 1,
	start: 702.4,
	end: 760.9,
	hook: 'Selling my company made me lonely',
	title: 'Lonely exit',
	caption: 'Nobody tells you this part.',
	reason: 'Personal story, starts at a new topic after a long pause.',
	score: 8,
	status: 'rendering',
	startCut: 'silence',
	endCut: 'silence',
	startPause: 1.4,
	endPause: 0.7,
	renderUrl: null
});
await db.doc('tvClip/c2').set({
	...clipBase,
	index: 2,
	start: 1402.1,
	end: 1449,
	hook: 'A Sherpa tells you what friends won’t',
	title: 'Sherpas',
	caption: 'Honesty from someone who made the climb.',
	reason: 'Clear idea; the end falls on a word.',
	score: 7,
	status: 'suggested',
	startCut: 'silence',
	endCut: 'word',
	startPause: 0.6,
	endPause: 0,
	renderUrl: null
});
console.log('Seeded. Sign in as admin@foundersforlifefellowship.com / flf-local-123');
