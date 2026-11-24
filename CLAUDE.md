# CLAUDE.md

FLF Hub: SvelteKit 2 (Svelte 5 runes) + Firebase (Firestore, Auth, Functions v2, App Hosting).
Same shape and rules as the EBS Hub (`barschool/aihub`); when in doubt, do what it does.

## Shape of a feature

Route in `src/routes/(app)/<feature>/`, UI in `src/lib/components/<feature>/`, types in
`src/lib/types/`, backend in `functions/src/lib/<feature>/`. Follow it for anything new.

## Rules

- **All writes go through callables.** The frontend only reads Firestore; rules grant read to
  the team (`role` claim `user` or `admin`) and nothing else.
- **Add an action, never an export.** Each feature has one `<feature>Action` dispatcher in
  `functions/src/index.ts`; a new operation is an entry with `permission` (or `adminOnly`) and
  a one-line JSDoc. Only non-callable triggers (`onRequest`, `onSchedule`,
  `onDocumentWritten`) get their own export.
- **One definition only.** Pipelines, automations, connections and permissions are defined in
  `functions/src/lib/**/config.ts` and fetched by the UI through `config.get` actions. Never copy
  them into `src/`.
- **Secrets only in Secret Manager** (`defineSecret`). Connection settings in Firestore are
  non-secret. Never log a secret.
- **Every query has an index** in `firestore.indexes.json` (composite ones; single-field are
  automatic on this standard-edition database). Prefer `count()` and `limit()`; a change that
  adds reads must say so.
- **Logging** only through `createLogger('<feature>')` from `functions/src/lib/utils.ts`.
- **A new connection** = an entry in `connections/config.ts` (with setup steps and secrets) and,
  when live, a case in `check()` in `connections/index.ts` so Health can test it.
- **A new automation** = an entry in `automations/config.ts` and its body wrapped in `run()` so
  its on/off switch, run count and errors are recorded.

## Frontend

- Svelte 5 runes only. Calls through `callAction('<feature>:<action>')` from `$lib/actions`.
- Icons deep-imported: `import X from '@lucide/svelte/icons/x'` (eslint enforces it).
- Dates only through `formatDate` / `formatDateTime` / `relative` from `$lib/utils`.
- Design: FLF tokens in `src/app.css` (teal `primary`, `ink`, `line`, `canvas`, Manrope).
  One accent colour (primary); `focus:ring-focus` for focus. Desktop-only, no breakpoints.

## Commands

`npm run lint`, `npm run check`, `cd functions && npm run build` before pushing.
Never commit or push unless asked in that same message.
