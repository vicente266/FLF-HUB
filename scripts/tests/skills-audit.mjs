/**
 * Pure tests of the Skills audit (functions/src/lib/skills/audit.ts): the front-matter parser,
 * name/description reading, skill paths, relative links, auditSkill() and the list-wide checks.
 * No emulator, no network. Needs the functions built (`npm run test:skills` builds them first).
 * Exits non-zero on the first failed check.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const built = fileURLToPath(new URL('../../functions/lib/lib/skills/audit.js', import.meta.url));
if (!existsSync(built)) {
	console.error(
		'Build the functions first: npm --prefix functions run build (or npm run test:skills).'
	);
	process.exit(1);
}
const require = createRequire(import.meta.url);
const {
	parseFrontMatter,
	describe,
	isSkillPath,
	relativeLinks,
	linkIssues,
	auditSkill,
	staleIssue,
	recompute
} = require(built);

let passed = 0;
function test(name, fn) {
	try {
		fn();
		passed++;
	} catch (e) {
		console.error(`FAIL ${name}\n`, e);
		process.exit(1);
	}
}
const codes = (issues) => issues.map((i) => `${i.level}:${i.code}`).sort();
const NOW = new Date('2026-11-26T12:00:00Z');
const good = {
	name: 'fellow-intro',
	description: 'Use when writing a first email to a founder who applied.',
	frontMatterError: null,
	body: '# Steps\n1. Read the application.\n2. Write.',
	updatedAt: new Date('2026-11-01T00:00:00Z')
};

// -- front matter -----------------------------------------------------------------------------

test('no front matter', () => {
	const fm = parseFrontMatter('# Title\nText');
	assert.equal(fm.present, false);
	assert.equal(fm.error, null);
	assert.equal(fm.body, '# Title\nText');
});

test('simple keys, quotes, comments, CRLF and BOM', () => {
	const fm = parseFrontMatter(
		"\uFEFF---\r\nname: my-skill\r\n# a comment\r\ndescription: \"Use when: quoted is fine\"\r\nmodel: 'it''s'\r\n---\r\n\r\nBody"
	);
	assert.equal(fm.error, null);
	assert.deepEqual(fm.data, {
		name: 'my-skill',
		description: 'Use when: quoted is fine',
		model: "it's"
	});
	assert.equal(fm.body, 'Body');
});

test('folded and literal blocks, plain continuation, nested map kept raw', () => {
	const fm = parseFrontMatter(
		'---\ndescription: >\n  Use when one\n  and two.\nnotes: |\n  line 1\n  line 2\nlong: first part\n  second part\nmetadata:\n  owner: flf\n---\nx'
	);
	assert.equal(fm.error, null);
	assert.equal(fm.data.description, 'Use when one and two.');
	assert.equal(fm.data.notes, 'line 1\nline 2');
	assert.equal(fm.data.long, 'first part second part');
	assert.match(fm.data.metadata, /owner: flf/);
});

test('malformed: never closed', () => {
	assert.match(parseFrontMatter('---\nname: x\n\nBody').error, /never ends/);
});
test('malformed: not key: value', () => {
	assert.match(parseFrontMatter('---\nname x\n---\n').error, /isn't "key: value"/);
});
test('malformed: unquoted ": " in a plain value', () => {
	assert.match(parseFrontMatter('---\ndescription: Use when: x\n---\n').error, /quotes/);
});
test('malformed: duplicate key', () => {
	assert.match(parseFrontMatter('---\nname: a\nname: b\n---\n').error, /twice/);
});
test('malformed: unclosed quote', () => {
	assert.match(parseFrontMatter('---\nname: "abc\n---\n').error, /isn't closed/);
});
test('malformed: stray indented line', () => {
	assert.match(parseFrontMatter('---\n  name: a\n---\n').error, /indented/);
});

// -- name and description ----------------------------------------------------------------------

test('front matter wins', () => {
	const d = describe('---\nname: n\ndescription: Use when x happens.\n---\n# Heading\n\nPara.');
	assert.equal(d.name, 'n');
	assert.equal(d.description, 'Use when x happens.');
	assert.equal(d.body, '# Heading\n\nPara.');
});
test('else first heading and first paragraph, code skipped', () => {
	const d = describe('```\ncode\n```\n# The title\n\nFirst line\nsecond line.\n\nNext.');
	assert.equal(d.name, 'The title');
	assert.equal(d.description, 'First line second line.');
});
test('nothing to name it', () => {
	const d = describe('just text');
	assert.equal(d.name, '');
	assert.equal(d.description, 'just text');
});

// -- paths and links -----------------------------------------------------------------------------

test('skill paths', () => {
	for (const p of [
		'SKILL.md',
		'a/b/SKILL.md',
		'.claude/skills/x/SKILL.md',
		'.claude/skills/x/reference.md',
		'.claude/commands/deploy.md',
		'skills/a.md',
		'skills/a/b.md'
	])
		assert.equal(isSkillPath(p), true, p);
	for (const p of [
		'README.md',
		'.claude/commands/sub/x.md',
		'docs/skills/a.md',
		'skills/a.txt',
		'.claude/settings.json'
	])
		assert.equal(isSkillPath(p), false, p);
});

test('relative links resolved, web links, anchors and code ignored', () => {
	const body =
		'See [ref](reference.md#part), [up](../shared/x.md), [root](/docs/a.md), ![img](./img.png), ' +
		'[web](https://x.com/a), [mail](mailto:a@b.c), [anchor](#top), `[code](no.md)`\n' +
		'```\n[fenced](no2.md)\n```\n[out](../../../../x.md) [sp](my%20file.md)';
	assert.deepEqual(relativeLinks(body, '.claude/skills/s/SKILL.md').sort(), [
		'../x.md',
		'.claude/skills/s/img.png',
		'.claude/skills/s/my file.md',
		'.claude/skills/s/reference.md',
		'.claude/skills/shared/x.md',
		'docs/a.md'
	]);
});

test('link issues', () => {
	const paths = new Set(['a/ref.md', 'a']);
	const issues = linkIssues(['a/ref.md', 'a/missing.md', '../x.md'], paths);
	assert.deepEqual(codes(issues), ['error:link', 'error:link']);
	assert.match(issues[0].message, /a\/missing\.md/);
	assert.match(issues[1].message, /outside the repo/);
});

// -- auditSkill ----------------------------------------------------------------------------------

test('a good skill has no issues', () => {
	assert.deepEqual(auditSkill(good, NOW), []);
});
test('missing name and description, empty body', () => {
	assert.deepEqual(codes(auditSkill({ ...good, name: '', description: '', body: ' ' }, NOW)), [
		'error:body',
		'error:description',
		'error:name'
	]);
});
test('description not starting with Use when: two wordings', () => {
	const a = auditSkill({ ...good, description: 'Drafts emails to founders when they apply.' }, NOW);
	assert.deepEqual(codes(a), ['warning:use-when']);
	assert.match(a[0].message, /doesn’t start/);
	const b = auditSkill({ ...good, description: 'Drafts emails to founders who applied.' }, NOW);
	assert.match(b[0].message, /doesn’t say when/);
});
test('description too short and too long', () => {
	assert.deepEqual(codes(auditSkill({ ...good, description: 'Use when x.' }, NOW)), [
		'warning:description-length'
	]);
	assert.deepEqual(
		codes(auditSkill({ ...good, description: `Use when ${'x'.repeat(1100)}` }, NOW)),
		['error:description-length']
	);
});
test('long body warns', () => {
	const body = Array.from({ length: 501 }, (_, i) => `line ${i}`).join('\n');
	assert.deepEqual(codes(auditSkill({ ...good, body }, NOW)), ['warning:length']);
});
test('front matter error reported', () => {
	assert.deepEqual(codes(auditSkill({ ...good, frontMatterError: 'bad' }, NOW)), [
		'error:front-matter'
	]);
});
test('broken links only with a repo tree', () => {
	const withLinks = { ...good, links: ['x/missing.md'] };
	assert.deepEqual(auditSkill(withLinks, NOW), []);
	assert.deepEqual(codes(auditSkill({ ...withLinks, repoPaths: new Set() }, NOW)), ['error:link']);
});
test('stale after 180 days, never without a date', () => {
	assert.equal(staleIssue(new Date('2026-05-01T00:00:00Z'), NOW)?.code, 'stale');
	assert.equal(staleIssue(new Date('2026-06-15T00:00:00Z'), NOW), null);
	assert.equal(staleIssue(null, NOW), null);
});

// -- list-wide checks ----------------------------------------------------------------------------

test('duplicates across sources, case-insensitive, and stale recomputed', () => {
	const list = [
		{ id: 'hub-1', name: 'Deploy', location: 'Hub', audit: [], updatedAt: NOW },
		{ id: 'github-1', name: 'deploy ', location: 'o/r/SKILL.md', audit: [], updatedAt: NOW },
		{
			id: 'drive-1',
			name: 'Other',
			location: 'Skills folder / Other',
			audit: [],
			updatedAt: new Date('2025-01-01T00:00:00Z')
		}
	];
	const changed = recompute(list, NOW);
	assert.deepEqual([...changed.keys()].sort(), ['drive-1', 'github-1', 'hub-1']);
	assert.match(changed.get('hub-1')[0].message, /o\/r\/SKILL\.md/);
	assert.equal(changed.get('drive-1')[0].code, 'stale');
	// Applied again: nothing changes.
	const again = list.map((s) => ({ ...s, audit: changed.get(s.id) }));
	assert.equal(recompute(again, NOW).size, 0);
	// The duplicate renamed: its warning goes.
	again[1].name = 'deploy-prod';
	const fixed = recompute(again, NOW);
	assert.deepEqual(fixed.get('hub-1'), []);
	assert.deepEqual(fixed.get('github-1'), []);
});

console.log(`skills audit: ${passed} checks passed`);
