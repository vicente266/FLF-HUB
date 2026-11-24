import prettier from 'eslint-config-prettier';
import { fileURLToPath } from 'node:url';
import { includeIgnoreFile } from '@eslint/compat';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';
import svelteConfig from './svelte.config.js';

const gitignorePath = fileURLToPath(new URL('./.gitignore', import.meta.url));

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	// tsc output. `functions/.gitignore` already ignores it for git, but includeIgnoreFile reads
	// the root .gitignore only — so without this, any `npm run build` in functions/ adds a few
	// hundred lint errors from compiled JS and hides the real ones.
	{ ignores: ['functions/lib/', 'scripts/'] },
	js.configs.recommended,
	...ts.configs.recommended,
	...svelte.configs.recommended,
	prettier,
	...svelte.configs.prettier,
	{
		languageOptions: {
			globals: { ...globals.browser, ...globals.node }
		},
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off',
			// The Hub is served at the domain root with no base path, so `resolve()` adds nothing.
			'svelte/no-navigation-without-resolve': 'off'
		}
	},
	{
		// Cloud Functions log through `createLogger` (functions/src/lib/utils.ts) so every line
		// carries its `[feature]` prefix; `console.*` bypasses that and is unfindable in logs.
		files: ['functions/src/**/*.ts'],
		// Callable payloads arrive untyped and are validated field by field (`str`, `oneOf`).
		rules: { 'no-console': 'error', '@typescript-eslint/no-explicit-any': 'off' }
	},
	{
		// The `@lucide/svelte` barrel re-exports ~3,800 icon modules. One such import anywhere in a
		// route's graph makes dev load and transform all of them on the first SSR request (12 s
		// instead of 2 s) and prebundle 2.8 MB for the browser. Type-only imports are erased before
		// resolution, so they cost nothing and stay allowed.
		files: ['src/**/*.{svelte,svelte.ts,ts,js}'],
		rules: {
			'@typescript-eslint/no-restricted-imports': [
				'error',
				{
					paths: [
						{
							name: '@lucide/svelte',
							message:
								"Deep-import the icon instead: import Search from '@lucide/svelte/icons/search'.",
							allowTypeImports: true
						}
					]
				}
			]
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser,
				svelteConfig
			}
		}
	}
);
