import { collection, getCountFromServer } from 'firebase/firestore';
import { db } from '$lib/firebase';

/**
 * Document counts for the sidebar's "empty" hints, keyed by collection. Each is one count
 * aggregation (one billed read) per page load: read once, shared by both copies of the sidebar.
 * Not live: a new strategy or video clears the hint on the next load.
 */
const counts = $state<Record<string, number>>({});
const asked: Record<string, boolean> = {};

export function navCount(name: string): number | undefined {
	if (!asked[name]) {
		asked[name] = true;
		getCountFromServer(collection(db, name))
			.then((r) => (counts[name] = r.data().count))
			.catch(() => {});
	}
	return counts[name];
}
