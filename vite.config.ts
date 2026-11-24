import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	// Icons are deep-imported; excluding the package avoids a reload per new icon in dev.
	optimizeDeps: { exclude: ['svelte', '@lucide/svelte'] },
	plugins: [tailwindcss(), sveltekit()],
	build: { chunkSizeWarningLimit: 700 }
});
