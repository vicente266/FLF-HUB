/** Environment flags, side-effect free so any module can import them. */

/** True when running under the Firebase emulator suite. */
export const useEmulator = process.env.FUNCTIONS_EMULATOR === 'true';

/** Region of every function, next to the eur3 database. */
export const REGION = 'europe-west4';
