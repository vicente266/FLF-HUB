import type { KnowledgeEntry } from '$lib/types/knowledge';

/** Words as the backend counts them (functions/src/lib/knowledge/sections.ts, `wordCount`). */
export const wordCount = (text: string) =>
	text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** A line of Markdown as plain text (as `plainLine` in the backend's sections.ts). */
export const plainLine = (line: string) =>
	line
		.replace(/^\s*(#{1,6}|[-*+]|>|\d+[.)])\s+/, '')
		.replace(/[*_`]+/g, '')
		.trim();

/** An entry's name everywhere, as Claude gets it (`titleOf` in the backend's sections.ts). */
export function titleOf(e: Pick<KnowledgeEntry, 'label' | 'description'>): string {
	const first = (e.description ?? '').split('\n').map(plainLine).find(Boolean);
	return e.label || (first ? first.slice(0, 80) : '(untitled)');
}

/** An entry's stored length, or counted for one not saved since lengths are stored. */
export const wordsOf = (e: KnowledgeEntry) =>
	typeof e.words === 'number' ? e.words : wordCount(e.description ?? '');
