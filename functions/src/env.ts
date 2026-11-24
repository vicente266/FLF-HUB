/** Environment flags, side-effect free so any module can import them. */

/** True when running under the Firebase emulator suite. */
export const useEmulator = process.env.FUNCTIONS_EMULATOR === 'true';

/** Region of every function, next to the eur3 database. */
export const REGION = 'europe-west4';

/**
 * Public origin of the deployed Hub: where the Claude connector sends people to approve, and the
 * links its tools return. Set it to the App Hosting domain before the first deploy.
 */
export const SITE_URL = process.env.FLF_HUB_URL || 'https://hub.foundersforlifefellowship.com';
