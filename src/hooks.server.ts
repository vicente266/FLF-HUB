import type { Handle } from '@sveltejs/kit';

/**
 * No page of the Hub may be framed: the Claude consent page's Approve button must not be
 * clickjacked, and nothing else needs framing.
 */
export const handle: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	response.headers.set('Content-Security-Policy', "frame-ancestors 'none'");
	response.headers.set('X-Frame-Options', 'DENY');
	return response;
};
