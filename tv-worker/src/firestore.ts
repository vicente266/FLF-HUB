import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { config } from './config.js';

// Application Default Credentials: `gcloud auth application-default login` on the Mac (README).
// Under the emulator (FIRESTORE_EMULATOR_HOST set) no credentials are needed.
initializeApp(
	process.env.FIRESTORE_EMULATOR_HOST
		? { projectId: config.projectId }
		: { projectId: config.projectId, credential: applicationDefault() }
);

export const db = getFirestore();
export const now = () => FieldValue.serverTimestamp();
export const videos = db.collection('tvVideo');
export const clips = db.collection('tvClip');
export const transcripts = db.collection('tvTranscript');
export const skills = db.collection('tvSkill');
