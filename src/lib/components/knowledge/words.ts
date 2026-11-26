import type { KnowledgeEntry } from '$lib/types/knowledge';

/** Words as the backend counts them (functions/src/lib/knowledge/sections.ts, `wordCount`). */
export const wordCount = (text: string) =>
	text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** An entry's stored length, or counted for one not saved since lengths are stored. */
export const wordsOf = (e: KnowledgeEntry) =>
	typeof e.words === 'number' ? e.words : wordCount(e.description ?? '');
