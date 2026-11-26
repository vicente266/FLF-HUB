/**
 * Pure tests of how Claude reads Knowledge: the outline (functions/src/lib/knowledge/sections.ts)
 * and the search scorer (functions/src/lib/knowledge/search.ts). No emulator, no network. Needs
 * the functions built (`npm run test:knowledge` builds them first). Exits non-zero on the first
 * failed check.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const lib = (f) =>
	fileURLToPath(new URL(`../../functions/lib/lib/knowledge/${f}`, import.meta.url));
if (!existsSync(lib('sections.js')) || !existsSync(lib('search.js'))) {
	console.error(
		'Build the functions first: npm --prefix functions run build (or npm run test:knowledge).'
	);
	process.exit(1);
}
const require = createRequire(import.meta.url);
const { sectionsOf, sectionText, slug, wordCount } = require(lib('sections.js'));
const { searchEntries, tokens, stem, snippet, MAX_RESULTS } = require(lib('search.js'));

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

// -- sections ------------------------------------------------------------------------------------

const DOC = [
	'Founders for Life: who we are.',
	'',
	'# The Pledge',
	'Fellows pledge 3% of income above the local average salary.',
	'## Duration',
	'Ten years.',
	'### Exceptions',
	'None, except **hardship**.',
	'## Duration',
	'A second heading with the same title.',
	'```',
	'# not a heading (code)',
	'```',
	'# Café & Prices 2026 #',
	'Prices in euros.'
].join('\n');

test('slug: lower case, accents folded, punctuation to dashes', () => {
	assert.equal(slug('Café & Prices 2026'), 'cafe-prices-2026');
	assert.equal(slug('  ¿Qué?  '), 'que');
	assert.equal(slug('!!!'), 'section');
	assert.ok(slug('x'.repeat(200)).length <= 60);
});

test('wordCount ignores markup-only chunks', () => {
	assert.equal(wordCount('# Title\n\n- one, two  **three** — 4'), 5);
	assert.equal(wordCount(''), 0);
});

test('sectionsOf: leading text, levels, unique ids, code fences ignored', () => {
	const s = sectionsOf(DOC);
	assert.deepEqual(
		s.map((x) => [x.id, x.level, x.title]),
		[
			['intro', 0, 'Introduction'],
			['the-pledge', 1, 'The Pledge'],
			['duration', 2, 'Duration'],
			['exceptions', 3, 'Exceptions'],
			['duration-2', 2, 'Duration'],
			['cafe-prices-2026', 1, 'Café & Prices 2026']
		]
	);
	for (const x of s) {
		assert.equal(typeof x.chars, 'number');
		assert.equal(typeof x.words, 'number');
		assert.equal('text' in x, false, 'the outline holds no text');
	}
	// A section holds its subsections: the Pledge counts more words than its Duration.
	const by = Object.fromEntries(s.map((x) => [x.id, x]));
	assert.ok(by['the-pledge'].words > by['duration'].words);
	assert.ok(by['duration'].words > by['exceptions'].words);
});

test('sectionsOf: no headings = one leading section; empty = none; cap', () => {
	assert.deepEqual(
		sectionsOf('Just a paragraph.').map((x) => x.id),
		['intro']
	);
	assert.deepEqual(sectionsOf(''), []);
	assert.deepEqual(
		sectionsOf('# A\n\n# B').map((x) => x.id),
		['a', 'b'],
		'no intro when nothing comes before the first heading'
	);
	const many = Array.from({ length: 150 }, (_, i) => `# H${i}\ntext`).join('\n');
	assert.equal(sectionsOf(many).length, 100);
	assert.equal(sectionsOf(many, 25).length, 25);
	// #### and #hashtag are not headings.
	assert.deepEqual(
		sectionsOf('#### Deep\n#hashtag\nok').map((x) => x.id),
		['intro']
	);
});

test('sectionsOf: Markdown export escapes are shown unescaped; ids stable across edits elsewhere', () => {
	assert.equal(sectionsOf('# Step 1\\. Apply')[0].title, 'Step 1. Apply');
	const a = sectionsOf('# One\nx\n# Two\ny').map((x) => x.id);
	const b = sectionsOf('# One\nchanged text here\n# Two\ny and more').map((x) => x.id);
	assert.deepEqual(a, b);
});

test('sectionText returns one section, its subsections included', () => {
	const r = sectionText(DOC, 'duration');
	assert.equal(r.section.title, 'Duration');
	assert.match(r.text, /^## Duration\nTen years\./);
	assert.match(r.text, /### Exceptions/);
	assert.doesNotMatch(r.text, /second heading/);
	assert.match(sectionText(DOC, 'duration-2').text, /second heading/);
	assert.match(sectionText(DOC, 'duration-2').text, /# not a heading/);
	assert.equal(sectionText(DOC, 'intro').text, 'Founders for Life: who we are.');
	assert.equal(sectionText(DOC, 'nope'), null);
});

// -- search --------------------------------------------------------------------------------------

test('tokens: lower case, accents folded, stop words dropped, plurals stemmed', () => {
	assert.deepEqual(tokens('What are the Pledges of the Fellows?'), ['pledge', 'fellow']);
	assert.deepEqual(tokens('Políticas de privacidad'), ['politica', 'de', 'privacidad']);
	assert.deepEqual(tokens('a I 3 x'), ['3']);
	assert.equal(stem('policies'), 'policy');
	assert.equal(stem('matches'), 'match');
	assert.equal(stem('class'), 'class');
});

const ENTRIES = [
	{
		id: 'pledge',
		label: 'The Pledge',
		useWhen: 'Use when someone asks what a Fellow pledges.',
		topics: ['Pledge'],
		type: 'offer',
		status: 'approved',
		rank: 5,
		description:
			'# Amount\nFellows pledge 3% of income above the average salary.\n# Duration\nThe pledge lasts ten years.'
	},
	{
		id: 'faq',
		label: 'FAQ',
		topics: [],
		type: 'other',
		status: 'draft',
		rank: 18,
		description: '# Misc\nThe pledge is mentioned here once.\n# Contact\nWrite to the team.'
	},
	{
		id: 'policy',
		label: 'Privacy policy',
		topics: ['Legal'],
		type: 'policies',
		status: 'approved',
		rank: 1,
		description: '# Data\nWe keep wellbeing data private. The pledge is mentioned here once.'
	}
];

test('search: title, use_when and topics weigh more than the text', () => {
	const hits = searchEntries(ENTRIES, 'pledge');
	assert.equal(hits[0].id, 'pledge');
	assert.ok(['amount', 'duration'].includes(hits[0].section));
	for (const k of ['id', 'section', 'sectionTitle', 'title', 'type', 'rank', 'status', 'snippet'])
		assert.ok(k in hits[0], `hit has ${k}`);
});

test('search: rank breaks ties (the policy before the FAQ)', () => {
	const hits = searchEntries(ENTRIES, 'mentioned here once');
	assert.deepEqual(
		hits.map((h) => h.id),
		['policy', 'faq']
	);
});

test('search: the section with more of the query words wins inside an entry', () => {
	const hits = searchEntries(ENTRIES, 'pledge ten years');
	assert.equal(hits[0].id, 'pledge');
	assert.equal(hits[0].section, 'duration');
});

test("search: words in the entry title don't hide the section that answers", () => {
	const pledge = {
		id: 'p',
		label: "The Founder's Pledge",
		useWhen: 'Use when someone asks what a Fellow pledges.',
		topics: ['Pledge'],
		rank: 5,
		description:
			'# What a Fellow pledges\nFellows pledge 3% of income.\n## Duration\nThe Pledge lasts ten years.'
	};
	const [best] = searchEntries([pledge], 'how long does the pledge last');
	assert.equal(best.section, 'duration');
	// The snippet is the body: the heading is in sectionTitle.
	assert.equal(best.snippet, 'The Pledge lasts ten years.');
});

test('search: accents and plurals fold; stop-word-only and unmatched queries give nothing', () => {
	assert.equal(searchEntries(ENTRIES, 'PRIVACÝ')[0].id, 'policy');
	assert.equal(searchEntries(ENTRIES, 'salaries')[0].id, 'pledge');
	assert.deepEqual(searchEntries(ENTRIES, 'what is the'), []);
	assert.deepEqual(searchEntries(ENTRIES, 'zebra'), []);
});

test('search: limit capped at MAX_RESULTS, at most two sections per entry', () => {
	const many = Array.from({ length: 30 }, (_, i) => ({
		id: `e${i}`,
		label: `Entry ${i}`,
		rank: 18,
		description: '# A\nfellow\n# B\nfellow\n# C\nfellow'
	}));
	assert.equal(searchEntries(many, 'fellow', 50).length, MAX_RESULTS);
	assert.equal(searchEntries(many, 'fellow', 3).length, 3);
	const one = searchEntries([many[0]], 'fellow', 10);
	assert.deepEqual(
		one.map((h) => h.section),
		['a', 'b']
	);
});

test('snippet: about 300 characters around the best match, cut on words', () => {
	const text = `${'filler words here '.repeat(60)}the Pledge lasts ten years ${'more filler '.repeat(60)}`;
	const s = snippet(text, new Set(['pledge', 'ten', 'year']));
	assert.ok(s.length <= 305, `length ${s.length}`);
	assert.match(s, /Pledge lasts ten years/);
	assert.ok(s.startsWith('…') && s.endsWith('…'));
	// Accented text keeps its accents in the snippet.
	assert.match(snippet('Política de privacidad: los datos.', new Set(['privacidad'])), /Política/);
});

console.log(`knowledge read: ${passed} checks passed`);
