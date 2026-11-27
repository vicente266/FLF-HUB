import { MAX_DESCRIPTION, MAX_LINES, MIN_DESCRIPTION, STALE_DAYS, type Level } from './config';

/**
 * The Skills audit (docs/skills.md, "The audit"): pure functions, no Firestore, no network, so
 * `scripts/tests/skills-audit.mjs` runs them as they are. Called on every import and save.
 */

/** One finding. `code` lets the list-wide checks (duplicate, stale) be recomputed on their own. */
export interface Issue {
	level: Level;
	code: string;
	message: string;
}

export interface FrontMatter {
	/** The file starts with a `---` block. */
	present: boolean;
	/** Its keys (top level, scalars only; nested values are kept as their raw text). */
	data: Record<string, string>;
	/** What it gets wrong, or null. */
	error: string | null;
	/** The text after it (the whole text when there is none). */
	body: string;
}

const KEY_LINE = /^([A-Za-z_][\w-]*)\s*:(?:\s+(.*)|\s*)$/;

/** A quoted YAML scalar's value, or null when the quote isn't closed where the value ends. */
function unquote(v: string): string | null {
	const q = v[0];
	if (q !== '"' && q !== "'") return v;
	const end = v.lastIndexOf(q);
	if (end <= 0) return null;
	// Only a comment may follow the closing quote.
	const rest = v.slice(end + 1).trim();
	if (rest && !rest.startsWith('#')) return null;
	const inner = v.slice(1, end);
	return q === '"' ? inner.replace(/\\"/g, '"').replace(/\\n/g, '\n') : inner.replace(/''/g, "'");
}

/**
 * The YAML front matter at the top of a skill file (`---` … `---`), read the way Claude reads a
 * SKILL.md header: top-level `key: value` lines, quoted values, `>` / `|` blocks and indented
 * continuation lines. Anything else is reported as malformed rather than guessed.
 */
export function parseFrontMatter(text: string): FrontMatter {
	const src = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
	const lines = src.split('\n');
	if (lines[0]?.trim() !== '---') return { present: false, data: {}, error: null, body: src };
	const close = lines.findIndex((l, i) => i > 0 && (l.trim() === '---' || l.trim() === '...'));
	if (close < 0)
		return {
			present: true,
			data: {},
			error: 'The front matter starts with --- but never ends with another ---.',
			body: src
		};
	const body = lines
		.slice(close + 1)
		.join('\n')
		.replace(/^\n+/, '');
	const data: Record<string, string> = {};
	const fail = (error: string): FrontMatter => ({ present: true, data, error, body });
	let i = 1;
	while (i < close) {
		const line = lines[i];
		if (!line.trim() || line.trim().startsWith('#')) {
			i++;
			continue;
		}
		const n = i + 1;
		if (/^\s/.test(line))
			return fail(`Line ${n} of the front matter is indented but belongs to no key.`);
		const m = KEY_LINE.exec(line);
		if (!m) return fail(`Line ${n} of the front matter isn't "key: value".`);
		const key = m[1];
		if (Object.hasOwn(data, key)) return fail(`"${key}" appears twice in the front matter.`);
		let value = (m[2] ?? '').trim();
		// The indented lines under it: a block, a continuation, or a nested map or list.
		const more: string[] = [];
		while (i + 1 < close && (/^\s/.test(lines[i + 1]) || !lines[i + 1].trim())) {
			more.push(lines[i + 1]);
			i++;
		}
		while (more.length && !more[more.length - 1].trim()) more.pop();
		const block = /^([|>])[+-]?\s*(#.*)?$/.exec(value);
		if (block) {
			const kept = more.map((l) => l.trim());
			value = block[1] === '|' ? kept.join('\n') : kept.filter(Boolean).join(' ');
		} else if (value.startsWith('"') || value.startsWith("'")) {
			const whole = [value, ...more.map((l) => l.trim())].join(' ');
			const v = unquote(whole);
			if (v === null) return fail(`The quoted value of "${key}" isn't closed.`);
			value = v;
		} else if (!value) {
			// A nested map or list: kept as its text, not read.
			value = more.join('\n');
		} else {
			// A plain value: `key: a: b` is a YAML error Claude's loader rejects.
			const plain = [value, ...more.map((l) => l.trim())].join(' ').replace(/\s+#.*$/, '');
			if (/:\s/.test(plain) || plain.endsWith(':'))
				return fail(`The value of "${key}" contains ": ": put it in quotes.`);
			value = plain;
		}
		data[key] = value.trim();
		i++;
	}
	return { present: true, data, error: null, body };
}

/** What a skill file says about itself: name, description, and its text without the front matter. */
export interface Described {
	/** Front matter `name`, else the first heading; '' when neither. */
	name: string;
	/** Front matter `description`, else the first paragraph; '' when neither. */
	description: string;
	frontMatterError: string | null;
	frontMatter: Record<string, string>;
	/** The text after the front matter. */
	body: string;
}

/** Name and description from the front matter, else the first heading and first paragraph. */
export function describe(text: string): Described {
	const fm = parseFrontMatter(text);
	const lines = fm.body.split('\n');
	let inFence = false;
	let heading = '';
	const para: string[] = [];
	for (const raw of lines) {
		const line = raw.trim();
		if (/^(```|~~~)/.test(line)) {
			inFence = !inFence;
			if (para.length) break;
			continue;
		}
		if (inFence) continue;
		const h = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
		if (h) {
			if (para.length) break;
			if (!heading) heading = h[1];
			continue;
		}
		if (!line) {
			if (para.length) break;
			continue;
		}
		para.push(line);
	}
	return {
		name: (fm.data.name ?? '').trim() || heading,
		description: (fm.data.description ?? '').trim() || para.join(' '),
		frontMatterError: fm.error,
		frontMatter: fm.data,
		body: fm.body
	};
}

/** Whether a repo path is a skill file (GITHUB_PATTERNS in config.ts). */
export function isSkillPath(path: string): boolean {
	const p = path.replace(/^\/+/, '');
	if (!/\.md$/i.test(p)) return false;
	if (/(^|\/)SKILL\.md$/i.test(p)) return true;
	if (p.startsWith('.claude/skills/')) return true;
	if (/^\.claude\/commands\/[^/]+\.md$/i.test(p)) return true;
	return p.startsWith('skills/');
}

/**
 * The files a skill links to with a relative Markdown link (`[x](ref.md)`, `![x](img.png)`),
 * resolved against the skill's own folder in the repo. Web links, anchors and links inside code
 * are left out. A link that climbs above the repo root comes back starting with `../`.
 */
export function relativeLinks(body: string, filePath: string): string[] {
	const text = body.replace(/(```|~~~)[\s\S]*?(\1|$)/g, '').replace(/`[^`\n]*`/g, '');
	const dir = filePath.split('/').slice(0, -1);
	const out = new Set<string>();
	for (const m of text.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g)) {
		let target = m[1];
		if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
		target = target.replace(/[#?].*$/, '');
		if (!target) continue;
		try {
			target = decodeURIComponent(target);
		} catch {
			// Kept as written.
		}
		// `/x` is the repo root on GitHub.
		const parts = target.startsWith('/') ? [] : [...dir];
		let escaped = false;
		for (const seg of target.split('/')) {
			if (!seg || seg === '.') continue;
			if (seg === '..') {
				if (parts.length) parts.pop();
				else escaped = true;
			} else parts.push(seg);
		}
		out.add((escaped ? '../' : '') + parts.join('/'));
	}
	return [...out];
}

/** What the audit looks at. */
export interface SkillFacts {
	name: string;
	description: string;
	frontMatterError: string | null;
	/** The text after the front matter. */
	body: string;
	/** Last change at its source; null when unknown (never flagged stale). */
	updatedAt: Date | null;
	/** GitHub only: its relative links (`relativeLinks`) and every path in its repo. */
	links?: string[];
	repoPaths?: ReadonlySet<string>;
}

const DAY = 86_400_000;

/** The not-updated check on its own: the nightly sync runs it on every skill. */
export function staleIssue(updatedAt: Date | null, now = new Date()): Issue | null {
	if (!updatedAt) return null;
	const days = Math.floor((now.getTime() - updatedAt.getTime()) / DAY);
	return days > STALE_DAYS
		? {
				level: 'warning',
				code: 'stale',
				message: `Not updated in ${days} days (over ${STALE_DAYS}): check it is still right.`
			}
		: null;
}

/** The relative-link check on its own: re-run against a new tree without re-reading the file. */
export function linkIssues(links: string[], repoPaths: ReadonlySet<string>): Issue[] {
	return links
		.filter((l) => l.startsWith('../') || !repoPaths.has(l))
		.map((l) => ({
			level: 'error' as const,
			code: 'link',
			message: l.startsWith('../')
				? `Links outside the repo (${l.slice(3) || 'its root'}).`
				: `Links to ${l}, which isn't in the repo.`
		}));
}

/** Every check that looks at one skill alone (the duplicate check needs the whole list). */
export function auditSkill(s: SkillFacts, now = new Date()): Issue[] {
	const out: Issue[] = [];
	const add = (level: Level, code: string, message: string) => out.push({ level, code, message });
	if (s.frontMatterError) add('error', 'front-matter', s.frontMatterError);
	if (!s.name.trim())
		add('error', 'name', 'No name: add `name:` to the front matter, or a heading at the top.');
	const d = s.description.trim();
	if (!d)
		add(
			'error',
			'description',
			'No description: add `description:` to the front matter saying what it does and when to use it.'
		);
	else {
		if (!/^use when\b/i.test(d))
			add(
				'warning',
				'use-when',
				/\bwhen(ever)?\b/i.test(d)
					? 'The description doesn’t start with “Use when …”.'
					: 'The description doesn’t say when to use it: start it with “Use when …”.'
			);
		if (d.length > MAX_DESCRIPTION)
			add(
				'error',
				'description-length',
				`The description is ${d.length} characters: Claude accepts ${MAX_DESCRIPTION} at most.`
			);
		else if (d.length < MIN_DESCRIPTION)
			add(
				'warning',
				'description-length',
				`The description is only ${d.length} characters: say what it does and when to use it.`
			);
	}
	const body = s.body.trim();
	if (!body) add('error', 'body', 'The body is empty: there are no instructions.');
	else {
		const lines = body.split('\n').length;
		if (lines > MAX_LINES)
			add(
				'warning',
				'length',
				`The body is ${lines} lines (over ${MAX_LINES}): move detail into linked files.`
			);
	}
	if (s.links && s.repoPaths) out.push(...linkIssues(s.links, s.repoPaths));
	const stale = staleIssue(s.updatedAt, now);
	if (stale) out.push(stale);
	return out;
}

/** A skill as the list-wide checks see it. */
export interface Listed {
	id: string;
	name: string;
	/** Where it lives, to tell people which other skill has the same name. */
	location: string;
	audit: Issue[];
	updatedAt: Date | null;
}

/**
 * The checks that need the whole list or today's date, recomputed for every skill: names used by
 * more than one skill (any source, any case) and not updated in STALE_DAYS. Returns the skills
 * whose audit changed, with their new audit.
 */
export function recompute(skills: Listed[], now = new Date()): Map<string, Issue[]> {
	const key = (n: string) => n.trim().toLowerCase();
	const byName = new Map<string, Listed[]>();
	for (const s of skills) {
		if (!key(s.name)) continue;
		byName.set(key(s.name), [...(byName.get(key(s.name)) ?? []), s]);
	}
	const changed = new Map<string, Issue[]>();
	for (const s of skills) {
		const next = s.audit.filter((i) => i.code !== 'duplicate' && i.code !== 'stale');
		const others = (byName.get(key(s.name)) ?? []).filter((o) => o.id !== s.id);
		if (others.length)
			next.push({
				level: 'warning',
				code: 'duplicate',
				// A Hub skill's location is just "Hub": say what it is instead.
				message: `Same name as ${others.map((o) => (o.location === 'Hub' ? 'a skill written in the Hub' : o.location)).join('; ')}. Claude can't tell them apart.`
			});
		const stale = staleIssue(s.updatedAt, now);
		if (stale) next.push(stale);
		if (JSON.stringify(next) !== JSON.stringify(s.audit)) changed.set(s.id, next);
	}
	return changed;
}
