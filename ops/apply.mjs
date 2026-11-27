// Applies the one-off data changes in ops/changes/ to the live Hub, each once: a change that ran is
// recorded in `opsApplied/{file}` and skipped after. Run by .github/workflows/hub-data.yml.
import { readdir } from 'node:fs/promises';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

initializeApp({ projectId: 'flfhub' });
const db = getFirestore();
const dir = new URL('./changes/', import.meta.url);

for (const file of (await readdir(dir)).filter((f) => f.endsWith('.mjs')).sort()) {
	const done = db.collection('opsApplied').doc(file);
	if ((await done.get()).exists) {
		console.log(`${file}: already applied`);
		continue;
	}
	const { default: change } = await import(new URL(file, dir).href);
	const result = await change(db, FieldValue);
	await done.set({ appliedAt: FieldValue.serverTimestamp(), result: result ?? null });
	console.log(`${file}: ${result ?? 'applied'}`);
}
