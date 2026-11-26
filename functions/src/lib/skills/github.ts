import { GITHUB_API } from './config';

/**
 * Read-only GitHub REST client for Skills. GET only, on the fixed host GITHUB_API, redirects
 * refused, so the token can't be sent anywhere else. The token is never logged.
 */

/** `owner/repo` lines of the `repos` setting; anything else is reported, not read. */
export function parseRepos(value: string | undefined): { repos: string[]; invalid: string[] } {
	const repos: string[] = [];
	const invalid: string[] = [];
	for (const raw of (value ?? '').split('\n')) {
		const line = raw
			.trim()
			.replace(/^https:\/\/github\.com\//, '')
			.replace(/\/+$/, '');
		if (!line) continue;
		if (/^[\w.-]+\/[\w.-]+$/.test(line)) {
			if (!repos.includes(line)) repos.push(line);
		} else invalid.push(raw.trim());
	}
	return { repos, invalid };
}

export class GithubError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
	}
}

/** One GET to the GitHub API. `path` starts with `/`; the host is always GITHUB_API. */
export async function ghGet(
	path: string,
	token: string,
	accept = 'application/vnd.github+json'
): Promise<Response> {
	const url = new URL(path, GITHUB_API);
	if (url.origin !== GITHUB_API) throw new GithubError(0, 'Refused: not the GitHub API.');
	const res = await fetch(url, {
		method: 'GET',
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: accept,
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': 'flf-hub-skills'
		},
		redirect: 'error',
		signal: AbortSignal.timeout(20_000)
	});
	if (!res.ok)
		throw new GithubError(res.status, `GitHub answered ${res.status} for ${url.pathname}.`);
	return res;
}

const enc = (repo: string) => repo.split('/').map(encodeURIComponent).join('/');
const encPath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** The repo's default branch (also proves the token can read it). */
export async function repoInfo(repo: string, token: string): Promise<{ defaultBranch: string }> {
	const r = (await (await ghGet(`/repos/${enc(repo)}`, token)).json()) as {
		default_branch?: string;
	};
	return { defaultBranch: r.default_branch || 'main' };
}

export interface TreeEntry {
	path: string;
	type: 'blob' | 'tree' | 'commit';
	sha: string;
}

/** Every path of a branch, recursive. `truncated` = GitHub cut the listing: it isn't whole. */
export async function tree(
	repo: string,
	branch: string,
	token: string
): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
	const r = (await (
		await ghGet(`/repos/${enc(repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`, token)
	).json()) as { tree?: TreeEntry[]; truncated?: boolean };
	return { entries: r.tree ?? [], truncated: r.truncated === true };
}

/** A file's text at a branch (contents API, raw). */
export async function fileText(
	repo: string,
	path: string,
	branch: string,
	token: string
): Promise<string> {
	const res = await ghGet(
		`/repos/${enc(repo)}/contents/${encPath(path)}?ref=${encodeURIComponent(branch)}`,
		token,
		'application/vnd.github.raw+json'
	);
	return (await res.text()).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

/** When the file last changed on the branch (its latest commit), or null. */
export async function lastCommitAt(
	repo: string,
	path: string,
	branch: string,
	token: string
): Promise<Date | null> {
	const res = await ghGet(
		`/repos/${enc(repo)}/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(branch)}&per_page=1`,
		token
	);
	const [c] = (await res.json()) as { commit?: { committer?: { date?: string } } }[];
	const d = c?.commit?.committer?.date;
	return d ? new Date(d) : null;
}

export const blobUrl = (repo: string, branch: string, path: string) =>
	`https://github.com/${repo}/blob/${encodeURIComponent(branch)}/${encPath(path)}`;
