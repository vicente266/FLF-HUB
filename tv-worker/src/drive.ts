import { createWriteStream, statSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { GoogleAuth } from 'google-auth-library';

// Drive with the same Application Default Credentials (needs the drive scope, see README).
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/drive'] });

async function token(): Promise<string> {
	const client = await auth.getClient();
	const t = await client.getAccessToken();
	if (!t.token) throw new Error('No Google access token: run the gcloud login in the README.');
	return t.token;
}

/** A Drive file's name and size, and whether it is a video. */
export async function fileInfo(id: string) {
	const res = await fetch(
		`https://www.googleapis.com/drive/v3/files/${id}?fields=name,mimeType,size&supportsAllDrives=true`,
		{ headers: { Authorization: `Bearer ${await token()}` } }
	);
	if (!res.ok)
		throw new Error(`Drive answered ${res.status} for the video (shared with this account?).`);
	return (await res.json()) as { name: string; mimeType: string; size?: string };
}

/** Download a Drive file to `dest`, streamed (videos are large). */
export async function download(id: string, dest: string): Promise<void> {
	const res = await fetch(
		`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`,
		{ headers: { Authorization: `Bearer ${await token()}` } }
	);
	if (!res.ok || !res.body) throw new Error(`Drive download failed: ${res.status}.`);
	await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
}

/** Upload a rendered clip (or a cover image) into a Drive folder; returns its id and link. */
export async function upload(
	path: string,
	folderId: string,
	name = basename(path),
	mimeType = 'video/mp4'
) {
	const meta = JSON.stringify({ name, parents: [folderId], mimeType });
	const boundary = `flf${Date.now()}`;
	const body = Buffer.concat([
		Buffer.from(
			`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`
		),
		Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
		readFileSync(path),
		Buffer.from(`\r\n--${boundary}--`)
	]);
	const res = await fetch(
		'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink',
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${await token()}`,
				'Content-Type': `multipart/related; boundary=${boundary}`,
				'Content-Length': String(body.length)
			},
			body
		}
	);
	if (!res.ok)
		throw new Error(`Drive upload failed: ${res.status} (${statSync(path).size} bytes).`);
	return (await res.json()) as { id: string; webViewLink: string };
}
