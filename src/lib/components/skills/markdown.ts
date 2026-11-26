/**
 * A small, safe Markdown renderer for skill previews: headings, paragraphs, lists, block quotes,
 * code, tables, bold, italics and links. Every bit of text is HTML-escaped before any tag is
 * added, and links only become anchors for http(s) and mailto (relative ones resolve against
 * `base`, the skill's own GitHub page), so the output is safe for `{@html}`.
 */

const esc = (s: string) =>
	s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
const unesc = (s: string) =>
	s
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&gt;/g, '>')
		.replace(/&lt;/g, '<')
		.replace(/&amp;/g, '&');

const LINK = 'text-primary-700 underline hover:text-primary-800';
const CODE = 'rounded bg-canvas px-1 font-mono text-[0.85em]';

/** An http(s) or mailto address for an href, or null. Relative ones resolve against `base`. */
function href(raw: string, base?: string): string | null {
	let url = raw;
	if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) {
		if (!base || url.startsWith('#')) return null;
		try {
			url = new URL(url, base).href;
		} catch {
			return null;
		}
	}
	return /^(https?:|mailto:)/i.test(url) ? url : null;
}

/** Bold, italics and links in already-escaped text. */
function rich(escaped: string, base?: string): string {
	// Links are set aside while emphasis is applied, so a `_` or `*` in an address stays as it is.
	const links: string[] = [];
	const styled = escaped
		.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
			const target = href(unesc(url), base);
			links.push(
				target
					? `<a href="${esc(target)}" target="_blank" rel="noopener noreferrer" class="${LINK}">${text}</a>`
					: `${text} (<span class="${CODE}">${url}</span>)`
			);
			return `\uE000${links.length - 1}\uE000`;
		})
		.replace(/\*\*(\S(?:[^*]*\S)?)\*\*/g, '<strong>$1</strong>')
		.replace(/(^|[^*\w])\*(\S(?:[^*]*\S)?)\*(?!\*)/g, '$1<em>$2</em>')
		.replace(/(^|[^_\w])_(\S(?:[^_]*\S)?)_(?!\w)/g, '$1<em>$2</em>');
	return styled.replace(/\uE000(\d+)\uE000/g, (_m, n: string) => links[Number(n)]);
}

/** One line of inline Markdown: code spans kept verbatim, the rest escaped then styled. */
function inline(text: string, base?: string): string {
	return text
		.split(/(`[^`]+`)/)
		.map((part) =>
			part.length > 1 && part.startsWith('`') && part.endsWith('`')
				? `<code class="${CODE}">${esc(part.slice(1, -1))}</code>`
				: rich(esc(part), base)
		)
		.join('');
}

const HEADING = [
	'mt-5 mb-2 text-xl font-bold',
	'mt-5 mb-2 text-lg font-bold',
	'mt-4 mb-1.5 font-bold',
	'mt-3 mb-1 text-sm font-bold',
	'mt-3 mb-1 text-sm font-semibold',
	'mt-3 mb-1 text-sm font-semibold text-ink-soft'
];

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/** Nested lists from consecutive list lines, by indentation. */
function list(lines: string[], base?: string): string {
	let html = '';
	const open: { indent: number; tag: string }[] = [];
	for (const line of lines) {
		const m = LIST_ITEM.exec(line);
		if (!m) {
			// A continuation line of the item above.
			html += ` ${inline(line.trim(), base)}`;
			continue;
		}
		const indent = m[1].replace(/\t/g, '  ').length;
		const tag = /\d/.test(m[2]) ? 'ol' : 'ul';
		while (open.length && open[open.length - 1].indent > indent)
			html += `</li></${open.pop()!.tag}>`;
		if (!open.length || open[open.length - 1].indent < indent) {
			const cls = tag === 'ol' ? 'list-decimal' : 'list-disc';
			html += `<${tag} class="${cls} my-1.5 space-y-0.5 pl-5">`;
			open.push({ indent, tag });
		} else html += '</li>';
		html += `<li>${inline(m[3], base)}`;
	}
	while (open.length) html += `</li></${open.pop()!.tag}>`;
	return html;
}

const cells = (line: string) =>
	line
		.trim()
		.replace(/^\||\|$/g, '')
		.split('|')
		.map((c) => c.trim());

function table(lines: string[], base?: string): string {
	const rows = lines.filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l));
	const [head, ...body] = rows;
	const th = cells(head)
		.map((c) => `<th class="border-b border-line px-2 py-1 text-left">${inline(c, base)}</th>`)
		.join('');
	const tr = body
		.map(
			(r) =>
				`<tr>${cells(r)
					.map((c) => `<td class="border-b border-line/40 px-2 py-1">${inline(c, base)}</td>`)
					.join('')}</tr>`
		)
		.join('');
	return `<table class="my-2 text-xs"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

/** Markdown to safe HTML. */
export function renderMarkdown(text: string, base?: string): string {
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	const out: string[] = [];
	let para: string[] = [];
	const flush = () => {
		if (para.length) out.push(`<p class="my-2">${para.map((l) => inline(l, base)).join(' ')}</p>`);
		para = [];
	};
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const t = line.trim();
		const fence = /^(```|~~~)/.exec(t);
		if (fence) {
			flush();
			const code: string[] = [];
			i++;
			while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++]);
			i++;
			out.push(
				`<pre class="my-2 overflow-x-auto rounded-lg bg-canvas px-3 py-2 font-mono text-xs">${esc(code.join('\n'))}</pre>`
			);
			continue;
		}
		const h = /^(#{1,6})\s+(.*?)\s*#*$/.exec(t);
		if (h) {
			flush();
			const n = h[1].length;
			out.push(`<h${n} class="${HEADING[n - 1]}">${inline(h[2], base)}</h${n}>`);
			i++;
			continue;
		}
		if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
			flush();
			out.push('<hr class="my-3 border-line" />');
			i++;
			continue;
		}
		if (t.startsWith('>')) {
			flush();
			const quote: string[] = [];
			while (i < lines.length && lines[i].trim().startsWith('>'))
				quote.push(lines[i++].trim().replace(/^>\s?/, ''));
			out.push(
				`<blockquote class="my-2 border-l-2 border-line pl-3 text-ink-soft">${quote.map((l) => inline(l, base)).join(' ')}</blockquote>`
			);
			continue;
		}
		if (LIST_ITEM.test(line)) {
			flush();
			const items: string[] = [];
			while (
				i < lines.length &&
				lines[i].trim() &&
				(LIST_ITEM.test(lines[i]) || /^\s+\S/.test(lines[i]))
			)
				items.push(lines[i++]);
			out.push(list(items, base));
			continue;
		}
		if (t.startsWith('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
			flush();
			const rows: string[] = [];
			while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(lines[i++]);
			out.push(table(rows, base));
			continue;
		}
		if (!t) flush();
		else para.push(t);
		i++;
	}
	flush();
	return out.join('\n');
}
