/**
 * The outline of a Knowledge entry (docs/knowledge.md, "Sections"): its Markdown split by headings
 * so Claude can read one part of a long document. Pure (no Firestore, no network), so
 * `scripts/tests/knowledge-read.mjs` runs it as it is.
 */

/** One part of an entry: a heading (`#`, `##`, `###`) and everything up to the next heading of the same or a higher level. */
export interface Section {
	/** Slug of the title, unique within the entry; stable while the title and its order stay. */
	id: string;
	title: string;
	/** 1–3 for `#`–`###`; 0 for the text before the first heading. */
	level: number;
	/** Length of the section's text, its subsections included. */
	chars: number;
	words: number;
}

/** A section with where its text sits in the Markdown (`text.slice(start, end)`). */
export interface SpannedSection extends Section {
	start: number;
	end: number;
	/** Its own text, without its heading line and up to the next heading of any level (what search scores). */
	bodyStart: number;
	ownEnd: number;
}

/** The id of the text before the first heading. */
export const LEAD_ID = 'intro';
const LEAD_TITLE = 'Introduction';
const MAX_SLUG = 60;

/** Lower case, accents folded (é → e). */
export const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Words: whitespace-separated chunks with at least one letter or digit (so `#` and `-` don't count). */
export const wordCount = (text: string) =>
	text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** A heading's title as a slug: `Pricing & Offers 2026` → `pricing-offers-2026`. */
export function slug(title: string): string {
	return (
		fold(title)
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, MAX_SLUG)
			.replace(/-+$/, '') || 'section'
	);
}

const HEADING = /^ {0,3}(#{1,3})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Every section with its span. Headings inside fenced code blocks are text, not headings. The
 * text before the first heading is its own section (`intro`) when it holds any words.
 */
export function splitSections(markdown: string): SpannedSection[] {
	const text = markdown ?? '';
	const heads: { level: number; title: string; start: number }[] = [];
	let fence = '';
	let offset = 0;
	for (const line of text.split('\n')) {
		const f = FENCE.exec(line);
		if (f) {
			if (!fence) fence = f[1][0];
			else if (f[1][0] === fence) fence = '';
		} else if (!fence) {
			const h = HEADING.exec(line);
			// Markdown export escapes characters (`\#`, `\*`): the title shows them unescaped.
			const title = h?.[2].replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1').trim();
			if (h && title) heads.push({ level: h[1].length, title, start: offset });
		}
		offset += line.length + 1;
	}
	const out: SpannedSection[] = [];
	const used = new Map<string, number>();
	const unique = (base: string) => {
		const n = (used.get(base) ?? 0) + 1;
		used.set(base, n);
		return n === 1 ? base : `${base}-${n}`;
	};
	const leadEnd = heads.length ? heads[0].start : text.length;
	const lead = text.slice(0, leadEnd);
	if (wordCount(lead))
		out.push(spanned(unique(LEAD_ID), LEAD_TITLE, 0, text, 0, leadEnd, 0, leadEnd));
	heads.forEach((h, i) => {
		// Up to the next heading of the same or a higher level: a `##` holds its `###`s.
		const next = heads.slice(i + 1).find((n) => n.level <= h.level);
		const end = next ? next.start : text.length;
		const ownEnd = i + 1 < heads.length ? heads[i + 1].start : text.length;
		const lineEnd = text.indexOf('\n', h.start);
		const bodyStart = lineEnd < 0 ? text.length : lineEnd + 1;
		out.push(
			spanned(unique(slug(h.title)), h.title, h.level, text, h.start, end, bodyStart, ownEnd)
		);
	});
	return out;
}

function spanned(
	id: string,
	title: string,
	level: number,
	text: string,
	start: number,
	end: number,
	bodyStart: number,
	ownEnd: number
): SpannedSection {
	const t = text.slice(start, end).trim();
	return {
		id,
		title,
		level,
		chars: t.length,
		words: wordCount(t),
		start,
		end,
		bodyStart,
		ownEnd
	};
}

/** The outline stored on an entry (no text), at most `max` sections. */
export function sectionsOf(markdown: string, max = 100): Section[] {
	return splitSections(markdown)
		.slice(0, max)
		.map(({ id, title, level, chars, words }) => ({ id, title, level, chars, words }));
}

/** One section's text, or null when the entry has no section with that id. */
export function sectionText(
	markdown: string,
	id: string
): { section: Section; text: string } | null {
	const s = splitSections(markdown).find((x) => x.id === id);
	if (!s) return null;
	const { id: sid, title, level, chars, words, start, end } = s;
	return {
		section: { id: sid, title, level, chars, words },
		text: (markdown ?? '').slice(start, end).trim()
	};
}
