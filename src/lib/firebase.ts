import { initializeApp } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import {
	getFirestore,
	initializeFirestore,
	persistentLocalCache,
	persistentMultipleTabManager,
	connectFirestoreEmulator
} from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions';
import { browser } from '$app/environment';
import { useEmulator } from '$lib/env';

export const app = initializeApp({
	apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
	authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
	projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
	storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
	messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
	appId: import.meta.env.VITE_FIREBASE_APP_ID
});

export const auth = getAuth(app);

// In the browser, a persistent cache shared across tabs: listeners serve from disk and only
// stream changes, which cuts billed reads. SSR has no IndexedDB.
export const db = browser
	? initializeFirestore(app, {
			localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
		})
	: getFirestore(app);

// Must match the functions' region or callables 404.
export const functions = getFunctions(app, 'europe-west4');

if (useEmulator && browser) {
	const host = import.meta.env.VITE_EMULATOR_HOST;
	connectAuthEmulator(auth, `http://${host}:${import.meta.env.VITE_AUTH_EMULATOR_PORT}`, {
		disableWarnings: true
	});
	connectFirestoreEmulator(db, host, Number(import.meta.env.VITE_FIRESTORE_EMULATOR_PORT));
	connectFunctionsEmulator(functions, host, Number(import.meta.env.VITE_FUNCTIONS_EMULATOR_PORT));
}
