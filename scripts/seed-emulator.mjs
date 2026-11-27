/**
 * Fill the local emulators with an admin, a teammate, groups and sample contacts.
 * Emulator-only and idempotent. Run with the emulators up:  node scripts/seed-emulator.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(new URL('../functions/package.json', import.meta.url));
const admin = require('firebase-admin');

process.env.FIRESTORE_EMULATOR_HOST ??= 'localhost:8081';
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= 'localhost:9099';
// The project the emulators run as (`npm run emulators:start` uses demo-flf-hub).
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? 'demo-flf-hub' });
const db = admin.firestore();
const auth = admin.auth();
const DAY = 86_400_000;
const ago = (days) => admin.firestore.Timestamp.fromMillis(Date.now() - days * DAY);

const GROUPS = {
	default: {
		name: 'Default',
		description: 'Everyone who signs in.',
		permissions: ['crm.any.read', 'health.any.read', 'skills.any.read']
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
			'health.any.read',
			'skills.any.read'
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
			'tv.any.write',
			'skills.any.read',
			'skills.any.write'
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
	['investor', 'Diego Alonso', 'diego@kapital.es', 'Kapital Seed', 'roster', 'referral', 50],
	// No owner, quiet for weeks (Home's "no owner" count, bulk assign), and one Lost.
	['fellow', 'Iris Novak', 'iris@tallow.io', 'Tallow', 'target', 'website', 21, 'none'],
	['investor', 'Hugo Brandt', 'hugo@alpine.vc', 'Alpine Capital', 'prospect', 'event', 30, 'none'],
	['fellow', 'Nina Park', 'nina@orbit.dev', 'Orbit', 'lost', 'website', 25]
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

for (const [i, [type, name, email, company, stage, source, days, noOwner]] of CONTACTS.entries()) {
	const owner = noOwner ? { uid: null, name: null } : owners[i % 2];
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
		...(stage === 'lost' ? { lostReason: 'Chose another programme' } : {}),
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
			by: owner.name ?? 'Seed',
			at: ago(Math.min(days, 5))
		});
	await ref.collection('activity').add({
		kind: 'note',
		text: 'Intro call: strong founder, clear on the long game.',
		by: owner.name ?? 'Seed',
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
// Skills: one per source plus one with audit problems, audited by the real code (functions/lib).
const auditPath = new URL('../functions/lib/lib/skills/audit.js', import.meta.url);
let skillAudit = null;
try {
	skillAudit = require(auditPath.pathname);
} catch {
	console.warn('Skills not seeded: build the functions first (cd functions && npm run build).');
}
if (skillAudit) {
	const { describe, auditSkill, relativeLinks, recompute } = skillAudit;
	const repoPaths = new Set([
		'.claude/skills/deploy-hub/SKILL.md',
		'.claude/skills/deploy-hub/checklist.md',
		'.claude/commands/standup.md'
	]);
	const SKILLS = [
		{
			id: 'hub-demo-intro',
			source: 'hub',
			location: 'Hub',
			url: '',
			name: 'fellow-intro-email',
			description: 'Use when writing the first email to a founder who applied to the Fellowship.',
			text: '# Steps\n\n1. Read their application in the CRM.\n2. Thank them, say what happens next.\n3. Sign as their Sherpa.',
			days: 3,
			by: 'Vicente Admin'
		},
		{
			id: 'github-demo-deploy',
			source: 'github',
			location: 'vicente266/FLF/.claude/skills/deploy-hub/SKILL.md',
			url: 'https://github.com/vicente266/FLF/blob/main/.claude/skills/deploy-hub/SKILL.md',
			path: '.claude/skills/deploy-hub/SKILL.md',
			text: '---\nname: deploy-hub\ndescription: Use when deploying the FLF Hub to production after the checks pass.\n---\n\n# Deploy the Hub\n\nFollow [the checklist](checklist.md), then see [rollback](rollback.md).\n\n```sh\nnpm run build\n```',
			days: 12,
			by: 'GitHub import'
		},
		{
			id: 'drive-demo-pitch',
			source: 'drive',
			location: 'Skills folder / Pitch / Investor pitch',
			url: 'https://drive.google.com',
			text: '---\nname: investor-pitch\ndescription: "Use when drafting a pitch for a fund or a university: the long game, the Pledge, Sherpas."\n---\n\n# Investor pitch\n\n- Open with the **long game**.\n- Explain the Pledge in one sentence.\n- End with a meeting request.',
			days: 40,
			by: 'Drive import'
		},
		{
			id: 'github-demo-standup',
			source: 'github',
			location: 'vicente266/FLF-Content/.claude/commands/standup.md',
			url: 'https://github.com/vicente266/FLF-Content/blob/main/.claude/commands/standup.md',
			path: '.claude/commands/standup.md',
			text: '---\nname: fellow-intro-email\ndescription: Writes: the standup\n---\nSummarise yesterday.',
			days: 300,
			by: 'GitHub import'
		}
	];
	const docs = SKILLS.map((k) => {
		const d =
			k.source === 'hub'
				? { name: k.name, description: k.description, frontMatterError: null, body: k.text }
				: describe(k.text);
		const links = k.path ? relativeLinks(d.body, k.path) : undefined;
		const updatedAt = new Date(Date.now() - k.days * DAY);
		return {
			id: k.id,
			data: {
				name: d.name,
				nameKey: d.name.trim().toLowerCase(),
				description: d.description,
				body: k.text,
				truncated: false,
				source: k.source,
				location: k.location,
				url: k.url,
				updatedAt: admin.firestore.Timestamp.fromDate(updatedAt),
				importedAt: ago(0),
				updatedBy: k.by,
				audit: auditSkill({ ...d, updatedAt, ...(links ? { links, repoPaths } : {}) }),
				...(k.path
					? { repo: k.location.split('/').slice(0, 2).join('/'), path: k.path, sha: 'demo', links }
					: {})
			}
		};
	});
	const changed = recompute(
		docs.map((x) => ({
			id: x.id,
			name: x.data.name,
			location: x.data.location,
			audit: x.data.audit,
			updatedAt: x.data.updatedAt.toDate()
		}))
	);
	for (const x of docs)
		await db.doc(`skill/${x.id}`).set({ ...x.data, audit: changed.get(x.id) ?? x.data.audit });
}
console.log('Seeded. Sign in as admin@foundersforlifefellowship.com / flf-local-123');
