import { fold, splitSections } from './sections';

/**
 * Knowledge search (docs/knowledge.md, "Search"): in memory over the settings-sized list, no
 * Firestore query of its own. Pure, so `scripts/tests/knowledge-read.mjs` runs it as it is.
 *
 * Each section of each entry is scored: a query word in the entry's title, topics or "Use when"
 * counts more than one in the text, a word in the section's heading more than one in its body,
 * and a section that holds more of the query's words beats one that repeats a single word. Ties go
 * to the stronger entry (lower rank: docs/knowledge.md, "Precedence").
 */

/** What search needs of an entry; the caller has already left out what the reader may not see. */
export interface SearchEntry {
	id: string;
	label?: string;
	useWhen?: string;
	topics?: string[];
	description: string;
	type?: string;
	status?: string;
	rank: number;
}

export interface SearchHit {
	id: string;
	section: string;
	sectionTitle: string;
	title: string;
	type: string;
	rank: number;
	status: string;
	/** Relative, for ordering only. */
	score: number;
	snippet: string;
}

export const MAX_RESULTS = 10;
const SNIPPET = 300;
/** At most this many sections of one entry, so one long document can't fill the results. */
const PER_ENTRY = 2;

const WEIGHT = { title: 6, topic: 5, useWhen: 4, heading: 4, coverage: 5 } as const;
/** A word counted at most this many times in one section's text. */
const MAX_REPEATS = 5;

/** Common English words that say nothing about what is searched for. */
const STOP_WORDS = new Set(
	(
		'a an and are as at be but by can do does for from has have how i if in into is it its me my ' +
		'no not of on or our so than that the their them then there these they this to us was we ' +
		'what when where which who why will with you your about all also any should would could'
	).split(' ')
);

/** Plural and singular match: `pledges` → `pledge`, `policies` → `policy`. */
export function stem(word: string): string {
	if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
	if (word.length > 4 && /(ches|shes|sses|xes|zes)$/.test(word)) return word.slice(0, -2);
	if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
	return word;
}

const WORD = /[\p{L}\p{N}]+/gu;
const keep = (w: string) => !STOP_WORDS.has(w) && (w.length > 1 || /\d/.test(w));

/** Lower case, accents folded, stop words dropped, plurals stemmed. */
export function tokens(text: string): string[] {
	return (fold(text ?? '').match(WORD) ?? []).filter(keep).map(stem);
}

/**
 * The text folded character by character, so a position in it is the same position in `text`
 * (needed to cut the snippet from the original).
 */
function foldInPlace(text: string): string {
	let out = '';
	for (let i = 0; i < text.length; i++) {
		const f = fold(text[i]);
		out += f.length === 1 ? f : ' ';
	}
	return out;
}

/** ~300 characters of `text` around the place where most of the query's words sit together. */
export function snippet(text: string, query: Set<string>): string {
	const folded = foldInPlace(text);
	const hits: { at: number; word: string }[] = [];
	for (const m of folded.matchAll(WORD)) {
		if (!keep(m[0])) continue;
		const w = stem(m[0]);
		if (query.has(w)) hits.push({ at: m.index, word: w });
	}
	let best = 0;
	let bestCount = 0;
	for (let i = 0; i < hits.length; i++) {
		const near = new Set<string>();
		for (let j = i; j < hits.length && hits[j].at - hits[i].at < SNIPPET * 0.8; j++)
			near.add(hits[j].word);
		if (near.size > bestCount) {
			bestCount = near.size;
			best = hits[i].at;
		}
	}
	let start = Math.max(0, best - 60);
	// Start and end on a word boundary.
	if (start > 0) {
		const space = text.slice(start, best).search(/\s/);
		if (space >= 0) start += space + 1;
	}
	let end = Math.min(text.length, start + SNIPPET);
	if (end < text.length) {
		const space = text.slice(start, end).search(/\s\S*$/);
		if (space > SNIPPET / 2) end = start + space;
	}
	const cut = text.slice(start, end).replace(/\s+/g, ' ').trim();
	return `${start > 0 ? '…' : ''}${cut}${end < text.length ? '…' : ''}`;
}

const counts = (words: string[]) => {
	const m = new Map<string, number>();
	for (const w of words) m.set(w, (m.get(w) ?? 0) + 1);
	return m;
};

/** The best sections for `query`, strongest first; [] when no query word is left after stop words. */
export function searchEntries(entries: SearchEntry[], query: string, limit = 5): SearchHit[] {
	const q = [...new Set(tokens(query))];
	if (!q.length) return [];
	const qset = new Set(q);
	const max = Math.min(Math.max(1, Math.floor(limit) || 1), MAX_RESULTS);
	const hits: SearchHit[] = [];
	for (const e of entries) {
		const text = e.description ?? '';
		const title = new Set(tokens(e.label ?? ''));
		const topics = new Set((e.topics ?? []).flatMap(tokens));
		const useWhen = new Set(tokens(e.useWhen ?? ''));
		const own: SearchHit[] = [];
		for (const s of splitSections(text)) {
			const heading = new Set(tokens(s.level ? s.title : ''));
			const bodyText = text.slice(s.bodyStart, s.ownEnd);
			const body = counts(tokens(bodyText));
			let score = 0;
			let matched = 0;
			for (const w of q) {
				const inMeta =
					(title.has(w) ? WEIGHT.title : 0) +
					(topics.has(w) ? WEIGHT.topic : 0) +
					(useWhen.has(w) ? WEIGHT.useWhen : 0);
				const inSection =
					(heading.has(w) ? WEIGHT.heading : 0) + Math.min(body.get(w) ?? 0, MAX_REPEATS);
				if (inMeta || inSection) matched++;
				score += inMeta + inSection;
			}
			if (!matched) continue;
			score += matched * WEIGHT.coverage;
			own.push({
				id: e.id,
				section: s.id,
				sectionTitle: s.title,
				title: e.label || '(untitled)',
				type: e.type ?? 'other',
				rank: e.rank,
				status: e.status ?? 'draft',
				score,
				snippet: snippet(bodyText.trim() || s.title, qset)
			});
		}
		// Sections only the entry's own title or topics matched score alike: keep the first.
		own.sort((a, b) => b.score - a.score);
		hits.push(...own.slice(0, PER_ENTRY));
	}
	return hits
		.sort((a, b) => b.score - a.score || a.rank - b.rank || a.id.localeCompare(b.id))
		.slice(0, max);
}
