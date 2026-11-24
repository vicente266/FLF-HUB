import { getFirestore } from 'firebase-admin/firestore';

/** The Hub's only database. One place, so no other file names it. */
export const db = getFirestore();
