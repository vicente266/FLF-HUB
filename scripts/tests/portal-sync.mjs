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

function sheet({
	annInEvent = true,
	renameProfilesColumn = false,
	taskStatus = 'To-do',
	annName = 'Ann Aware',
	annStage = 'FOF - They are Aware',
	// Wealth reports of Ana's in the sheet: the first, or both.
	wealthReports = 2,
	tasks = true
} = {}) {
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
				// As the real sheet returns it: the error with its explanation appended.
				Growth: '#DIV/0! (Function DIVIDE parameter 2 cannot be zero.)',
				'Sherpa Name': 'Bo'
			}),
			// Already in the Hub, made by hand with the same email.
			row(PROFILES, { Email: 'dora@hub.io', Name: 'Dora Hub', Role: 'Fellow' }),
			// The same person as the CRM tab's name-only "Eve Merge" row.
			row(PROFILES, { Email: 'eve@merge.io', Name: 'Eve Merge', Role: 'Fellow' })
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
			[annName, 'ann@aware.io', 'Awareco', '', 'Awaiting for Response', annStage, '', '7', '', ''],
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
			],
			['Carl Crm', 'carl@crm.io', '', '', '', 'Targets', '', '', '', ''],
			['Eve Merge', '', '', '', '', 'Targets', '', '', '', '']
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
			...(tasks ? [['Prepare retreat', 'Vicente', taskStatus, '', '30/11/2026', 'T1']] : [])
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
			...wealthRows.slice(0, wealthReports)
		],
		Events: [EVENTS, event(annInEvent ? ['Ted Teaser', 'Ann Aware'] : ['Ted Teaser'])]
	};
}

const wealthRow = (id, date, report, gross, net) => [
	id,
	'ana.fellow@test.io',
	'Ana Fellow',
	date,
	report,
	'Work Income',
	'',
	'',
	'',
	'',
	'',
	'EUR',
	gross,
	net,
	'',
	gross,
	net,
	''
];
const wealthRows = [
	wealthRow('W1', '2026-07-01', 'Initial Financial Report', '60000', '40000'),
	wealthRow('W2', '2026-10-01', 'Quarterly Report', '€65,000', '45.000,50')
];

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
	portal: { sheetStage: 'aware', syncedAt: Ts.now() },
	needsAttention: true,
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

// -- a contact imported before the sheet's dates were used, given an owner by hand before tasks
// followed the owner: its automation task still sits with whoever moved it ------------------------

const annId = portal.contactIdOf('ann@aware.io', 'Ann Aware');
await db.doc(`contact/${annId}`).set({
	type: 'fellow',
	name: 'Ann Aware',
	email: 'ann@aware.io',
	company: 'Awareco',
	linkedin: '',
	phone: '',
	tags: [],
	notes: '',
	stage: 'aware',
	open: true,
	ownerUid: 'u2',
	ownerName: 'Boris Kowalski',
	source: 'portal',
	createdBy: 'portal-sync',
	needsAttention: false,
	portal: { sheetStage: 'aware', syncedAt: Ts.now() },
	lastActivityAt: Ts.now(),
	createdAt: Ts.now()
});
await db.doc('task/t2').set({
	contactId: annId,
	title: 'Send the teaser',
	done: false,
	automationId: 'stage-follow-up',
	assigneeUid: 'u1',
	dueAt: Ts.now()
});
await db.doc('task/t3').set({
	contactId: annId,
	title: 'Call Ann about the retreat',
	done: false,
	source: 'manual',
	assigneeUid: 'u1',
	dueAt: Ts.now()
});

await db.doc('task/t4').set({
	contactId: annId,
	title: 'Plan the next interaction',
	done: false,
	automationId: 'next-step-task',
	assigneeUid: 'u2',
	dueAt: Ts.now()
});

// -- contacts that must be merged, not duplicated ----------------------------------------------

// Saved by a name-only row before the sheet gave Carl an email.
const carlOld = portal.contactIdOf('', 'Carl Crm');
const fellowDoc = (name, email, source) => ({
	type: 'fellow',
	name,
	email,
	company: '',
	linkedin: '',
	phone: '',
	tags: [],
	notes: '',
	stage: 'target',
	open: true,
	ownerUid: null,
	ownerName: null,
	source,
	needsAttention: false,
	lastActivityAt: Ts.now(),
	createdAt: Ts.now()
});
await db.doc(`contact/${carlOld}`).set(fellowDoc('Carl Crm', '', 'portal'));
await db
	.doc(`contact/${carlOld}/activity/c1`)
	.set({ kind: 'note', text: 'Carl note to keep', at: Ts.now() });
// Made in the Hub by hand, with the email the sheet has.
await db.doc('contact/manual-dora').set(fellowDoc('Dora Hub', 'dora@hub.io', 'manual'));

console.log('Amounts and dates');
const amounts = {
	40000: 40000,
	'€40,000': 40000,
	'1,250,000': 1250000,
	'40.000,50': 40000.5,
	'40,000.50': 40000.5,
	'12,5': 12.5,
	'-3,000': -3000,
	'': null
};
for (const [text, expected] of Object.entries(amounts))
	check(portal.num(text) === expected, `amount "${text}" reads as ${expected}`);
check(
	portal.parseDate('31/02/2026') === null &&
		portal.parseDate('10/13/2026') === null &&
		portal.parseDate('2026-02-30') === null &&
		portal.parseDate('29/02/2028')?.toISOString().startsWith('2028-02-29'),
	'an impossible date reads as no date'
);

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
check(
	beaMoney.growth === '',
	'a spreadsheet error (#DIV/0! with its explanation) is read as empty'
);
check(
	(await db.doc('task/t2').get()).data().assigneeUid === 'u2',
	'an automation task left with whoever moved the contact goes to its owner'
);
check(
	(await db.doc('task/t3').get()).data().assigneeUid === 'u1',
	'a manual task keeps its assignee'
);
const byName = async (name) =>
	(await db.collection('contact').where('name', '==', name).get()).docs;
check(
	(await db.doc(`contact/${fresh}`).get()).data().needsAttention === false,
	'a stage move from the sheet clears “needs attention”'
);
const carl = await byName('Carl Crm');
check(
	carl.length === 1 &&
		carl[0].id === portal.contactIdOf('carl@crm.io', 'Carl Crm') &&
		(await exists(`contact/${carl[0].id}/activity/c1`)),
	'a contact saved under the name-only id moves to the email id'
);
const dora = await byName('Dora Hub');
check(
	dora.length === 1 &&
		dora[0].id === portal.contactIdOf('dora@hub.io', 'Dora Hub') &&
		dora[0].data().source === 'manual',
	'a Hub contact with the same email is merged, not duplicated'
);
const eve = await byName('Eve Merge');
check(
	eve.length === 1 &&
		eve[0].id === portal.contactIdOf('eve@merge.io', 'Eve Merge') &&
		eve[0].data().stage === 'target' &&
		first.skipped.some((s) => s.startsWith('Merged: "Eve Merge"')),
	'a name-only CRM row and a Profiles row with an email are one contact, listed as merged'
);

console.log('Second sync, same sheet');
const second = await sync('second');
check(second.created === 0 && second.moved === 0, 'running again changes nothing');

console.log('Sheet tasks: the last change wins');
const sheetTask = (await db.collection('task').where('title', '==', 'Prepare retreat').get())
	.docs[0];
await sheetTask.ref.update({ done: true });
await sync('task-hub');
check(
	(await sheetTask.ref.get()).data().done === true,
	'a sheet task ticked done in the Hub stays done'
);
await sheetTask.ref.update({ done: false });
await sync('task-sheet', { taskStatus: 'Done' });
check((await sheetTask.ref.get()).data().done === true, 'a status changed in the sheet is applied');

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
	fourth.created === 0 && (await byName('Eve Merge')).length === 1,
	'a name-only row is not created while its email row is unreadable'
);
check(
	before > 0 && (await db.collection('wellbeing').get()).size === before,
	'a partial read deletes no wellbeing data'
);

console.log('A name corrected in the Hub');
const annRef = db.doc(`contact/${ann}`);
await annRef.update({ name: 'Ann A. Aware' });
await sync('name-hub');
check((await annRef.get()).data().name === 'Ann A. Aware', 'a name corrected in the Hub sticks');
await sync('name-sheet', { annName: 'Ann Awarest' });
check((await annRef.get()).data().name === 'Ann Awarest', 'a name changed in the sheet is applied');

console.log('Finance report removed from the sheet');
const anaMoney = db.doc(`fellowFinance/${portal.contactIdOf('ana.fellow@test.io', 'Ana Fellow')}`);
const quarterly = (await anaMoney.get()).data().reports['Quarterly Report (2026-10-01)'];
check(
	quarterly?.['Work Income'].gross === 65000 && quarterly['Work Income'].net === 45000.5,
	'report amounts with thousands separators are read whole'
);
await sync('one-report', { annName: 'Ann Awarest', wealthReports: 1 });
check(
	Object.keys((await anaMoney.get()).data().reports).join() ===
		'Initial Financial Report (2026-07-01)',
	'a report removed from the sheet leaves the Hub'
);

console.log('Task removed from the sheet');
await sync('no-tasks', { annName: 'Ann Awarest', tasks: false });
const gone = (await sheetTask.ref.get()).data();
check(
	gone.done === true && gone.removedFromSheet === true,
	'a sheet task deleted from the sheet is closed and kept'
);
await sync('tasks-back', { annName: 'Ann Awarest' });
const back = (await sheetTask.ref.get()).data();
check(
	back.removedFromSheet === false && back.done === false,
	'and reopens when it is back in the sheet'
);

console.log('The sheet moves a contact to a final stage');
await sync('ann-fellow', { annName: 'Ann Awarest', annStage: 'Fellows' });
check(
	(await db.doc('task/t4').get()).data().done === true,
	'a final stage closes the next-step task'
);

console.log(`\n${checks} checks passed`);
process.exit(0);
