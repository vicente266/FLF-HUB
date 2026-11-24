import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// A static single-page app for Hostinger: every route is served by index.html, which
		// static/.htaccess rewrites to. All data comes from Firebase in the browser.
		adapter: adapter({ fallback: 'index.html' })
	}
};

export default config;
