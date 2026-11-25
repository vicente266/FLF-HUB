/**
 * Integration test of the portal sheet import (functions/src/lib/portal), against the Firestore
 * emulator with invented people. Run with `npm test` (it starts the emulator), never against a
 * real project. Exits non-zero on the first failed check.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
	console.error('Run through `npm test`: it needs the Firestore emulator.');
	process.exit(1);
}
process.env.FUNCTIONS_EMULATOR = 'true';

const req = createRequire(new URL('../../functions/package.json', import.meta.url));
const admin = req('firebase-admin');
admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'demo-flf-hub' });
const db = admin.firestore();
const portal = req('../functions/lib/lib/portal/index.js');
const Ts = admin.firestore.Timestamp;

// -- fixtures: the real sheet's headers, invented rows ------------------------------------------

const PROFILES = [
	'Show in portal',
	'Email',
	'PasswordHash',
	'Intro Text',
	'Name',
	'Username',
	'Role',
	'Cohort',
	'Pledge Signed',
	'Pledge Date',
	'Contract URL',
	'Starting Income',
	'Current Income',
	'Growth',
	'Company Name',
	'Company URL',
	'LinkedIn',
	'Location',
	'Sherpa Name',
	'Archetype',
	'Reasons Why',
	'Funnel Stage',
	'Notes',
	'Permissions',
	'Reset Token',
	'Reset Expiry',
	'Read Versions',
	'Last Interaction'
];
const row = (header, values) => header.map((h) => values[h] ?? '');
const EVENTS = [
	'Show in portal',
	'Title',
	'Type',
	'Date',
	'Description',
	...Array.from({ length: 19 }, (_, i) => `Participant${i + 1}`)
];
const event = (names) => [
	'TRUE',
	'Intro call',
	'Meeting',
	'2026-11-20',
	'',
	...names,
	...Array(19 - names.length).fill('')
];

function sheet({ annInEvent = true, renameProfilesColumn = false } = {}) {
	const profiles = renameProfilesColumn
		? PROFILES.map((h) => (h === 'Archetype' ? 'Archetype RENAMED' : h))
		: PROFILES;
	return {
		Profiles: [
			profiles,
			row(PROFILES, {
				Email: 'admin@flf.test',
				PasswordHash: 'SECRET-HASH',
				Name: 'Aleks',
				Role: 'Admin'
			}),
			row(PROFILES, {
				Email: 'ana.fellow@test.io',
				PasswordHash: 'SECRET-HASH',
				'Reset Token': 'SECRET-RESET',
				Name: 'Ana Fellow',
				Role: 'Fellow',
				Cohort: '1',
				'Pledge Signed': 'TRUE',
				'Starting Income': '40000',
				'Current Income': '65000',
				'Company Name': 'Fellowco',
				'Sherpa Name': 'Vicente'
			}),
			row(PROFILES, {
				Email: 'boris@flf.test',
				Name: 'Boris Sherpa',
				Username: 'Bo',
				Role: 'Sherpa'
			}),
			row(PROFILES, {
				Email: 'bea@fellow.io',
				Name: 'Bea Fellow',
				Role: 'Fellow',
				'Pledge Signed': '10/06/2026',
				'Pledge Date': '10/06/2026',
				Growth: '#DIV/0!',
				'Sherpa Name': 'Bo'
			})
		],
		'CRM ': [
			[
				'Name',
				'Email',
				'Company Name',
				'Last Meeting (N8N)',
				'Status',
				'Stage',
				'Timeline',
				'Scoring',
				'Notes',
				'Reason Lost'
			],
			['Ana Fellow', 'ana.fellow@test.io', 'Fellowco', '', '', 'Fellows', '', '9', '', ''],
			['Bea Fellow', 'bea@fellow.io', '', '2026-09-01', '', 'Fellows', '', '', '', ''],
			[
				'Ann Aware',
				'ann@aware.io',
				'Awareco',
				'',
				'Awaiting for Response',
				'FOF - They are Aware',
				'',
				'7',
				'',
				''
			],
			[
				'Ted Teaser',
				'ted@teaser.io, ted.alt@teaser.io',
				'Teaserco',
				'',
				'Plan Interaction',
				'FOF - Teaser Received',
				'',
				'8',
				'',
				''
			]
		],
		Applications: [
			[
				'Name',
				'Email',
				'Company',
				'Status',
				'LinkedIn',
				'WhyNow',
				'ReferredBy',
				'AppliedAt',
				'_fail',
				'error'
			],
			[
				'Paula Applicant',
				'paula@apply.io',
				'Applyco',
				'Pending Review',
				'',
				'Second company',
				'',
				'2026-11-20',
				'',
				''
			]
		],
		Tasks: [
			['Task', 'Owner', 'Status', 'Notes', 'Due Date', 'Task ID'],
			['Prepare retreat', 'Vicente', 'To-do', '', '30/11/2026', 'T1']
		],
		Perma: [
			[
				'Submission ID',
				'Founder Email',
				'Founder',
				'Completion Date',
				'P',
				'E',
				'R',
				'M',
				'A',
				'N',
				'H',
				'Loneliness',
				'Happiness',
				'Overall'
			],
			[
				'S1',
				'ana.fellow@test.io',
				'Ana Fellow',
				'2026-10-01',
				'8',
				'7',
				'6',
				'8',
				'6',
				'4',
				'5',
				'6',
				'9',
				'7'
			]
		],
		Wealth: [
			[
				'Submission ID',
				'Founder Email',
				'Founder',
				'Completion Date',
				'Report Type',
				'Row Type',
				'Name',
				'Type',
				'Units',
				'Of Total',
				'Role',
				'Currency',
				'Gross Income',
				'Net Income',
				'Value',
				'Gross EUR',
				'Net EUR',
				'Value EUR'
			],
			[
				'W1',
				'ana.fellow@test.io',
				'Ana Fellow',
				'2026-07-01',
				'Initial Financial Report',
				'Work Income',
				'',
				'',
				'',
				'',
				'',
				'EUR',
				'60000',
				'40000',
				'',
				'60000',
				'40000',
				''
			]
		],
		Events: [EVENTS, event(annInEvent ? ['Ted Teaser', 'Ann Aware'] : ['Ted Teaser'])]
	};
}

const dir = mkdtempSync(join(tmpdir(), 'flf-portal-'));
async function sync(name, options) {
	const file = join(dir, `${name}.json`);
	writeFileSync(file, JSON.stringify(sheet(options)));
	process.env.SHEETS_FIXTURE = file;
	return portal.run();
}
const exists = async (path) => (await db.doc(path).get()).exists;
let checks = 0;
const check = (ok, message) => {
	assert.ok(ok, message);
	checks++;
	console.log(`  ✓ ${message}`);
};

// -- a contact saved by the previous id scheme, with Hub data to keep ---------------------------

const legacy = portal.legacyContactIdOf('ted@teaser.io, ted.alt@teaser.io', 'Ted Teaser');
const fresh = portal.contactIdOf('ted@teaser.io, ted.alt@teaser.io', 'Ted Teaser');
await db
	.doc('user/u1')
	.set({ email: 'vicente@flf.test', name: 'Vicente', role: 'admin', groups: [] });
await db
	.doc('user/u2')
	.set({ email: 'boris@flf.test', name: 'Boris Kowalski', role: 'user', groups: [] });
await db.doc(`contact/${legacy}`).set({
	type: 'fellow',
	name: 'Ted Teaser',
	email: 'ted@teaser.io',
	company: 'Teaserco',
	linkedin: '',
	phone: '',
	tags: [],
	notes: '',
	stage: 'aware',
	open: true,
	ownerUid: 'u1',
	ownerName: 'Vicente',
	source: 'portal',
	needsAttention: false,
	portal: { sheetStage: 'aware', syncedAt: Ts.now() },
	lastActivityAt: Ts.now(),
	createdAt: Ts.now()
});
await db
	.doc(`contact/${legacy}/activity/a1`)
	.set({ kind: 'note', text: 'Hub note to keep', at: Ts.now() });
await db.doc('task/t1').set({
	contactId: legacy,
	title: 'Send the teaser',
	done: false,
	automationId: 'stage-follow-up',
	dueAt: Ts.now()
});

console.log('First sync');
const first = await sync('first');
check(legacy !== fresh, 'a multi-email cell changes the contact id');
check(
	!(await exists(`contact/${legacy}`)) && (await exists(`contact/${fresh}`)),
	'the old contact moves to its new id'
);
check(
	(await db.collection('contact').where('name', '==', 'Ted Teaser').get()).size === 1,
	'no duplicate contact'
);
check(await exists(`contact/${fresh}/activity/a1`), 'the Hub timeline moves with it');
const task = (await db.doc('task/t1').get()).data();
check(task.contactId === fresh, 'its tasks move with it');
check(
	task.done === true && task.superseded === true,
	'a stage move from the sheet closes the old stage’s tasks'
);
check(
	(await db.doc(`contact/${fresh}`).get()).data().stage === 'teaser',
	'the sheet’s stage is applied'
);
const everything = JSON.stringify((await db.collection('contact').get()).docs.map((d) => d.data()));
check(!/SECRET|PasswordHash|Reset/.test(everything), 'no password hash or reset token is imported');
check(first.created >= 3, 'new people are created');
const bea = (
	await db.doc(`contact/${portal.contactIdOf('bea@fellow.io', 'Bea Fellow')}`).get()
).data();
check(bea.ownerUid === 'u2', 'a Sherpa named by their portal Username becomes the owner');
check(bea.portal.pledgeSigned === true, 'a date in Pledge Signed counts as signed');
check(
	bea.createdAt.toDate().toISOString().startsWith('2026-06-10') &&
		bea.lastActivityAt.toDate().toISOString().startsWith('2026-09-01'),
	'created and last activity come from the sheet’s dates, not the import time'
);
const beaMoney = (
	await db.doc(`fellowFinance/${portal.contactIdOf('bea@fellow.io', 'Bea Fellow')}`).get()
).data();
check(beaMoney.growth === '', 'a spreadsheet error (#DIV/0!) is read as empty');

console.log('Second sync, same sheet');
const second = await sync('second');
check(second.created === 0 && second.moved === 0, 'running again changes nothing');

console.log('Third sync, a participant removed from a kept meeting');
const ann = portal.contactIdOf('ann@aware.io', 'Ann Aware');
const eventId = (await db.collection('event').get()).docs[0]?.id;
check(
	Boolean(eventId) && (await exists(`contact/${ann}/activity/${eventId}`)),
	'a meeting is on each participant’s timeline'
);
await sync('third', { annInEvent: false });
check(
	!(await exists(`contact/${ann}/activity/${eventId}`)),
	'it leaves the timeline of someone removed from it'
);
check(await exists(`contact/${fresh}/activity/${eventId}`), 'and stays on the others’');

console.log('Fourth sync, a column renamed in Profiles');
const before = (await db.collection('wellbeing').get()).size;
const fourth = await sync('fourth', { annInEvent: false, renameProfilesColumn: true });
check(Boolean(fourth.drift.Profiles), 'the renamed column is reported as drift');
check(
	before > 0 && (await db.collection('wellbeing').get()).size === before,
	'a partial read deletes no wellbeing data'
);

console.log(`\n${checks} checks passed`);
process.exit(0);
