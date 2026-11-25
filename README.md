# FLF Hub

Internal hub of the Founders for Life Fellowship: CRM for Fellows, Gurus and Investors,
tasks, reports, automations, and the connections that feed them. SvelteKit + Firebase, the
same architecture as the EBS Hub (`barschool/aihub`).

## Modules

| Module       | Route                           | What it does                                                                                   |
| ------------ | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| Home         | `/`                             | My tasks, contacts that need attention, KPIs, system health                                    |
| CRM          | `/crm`, `/crm/[id]`             | Fellows, Gurus, Investors and Partners: board + list, timeline, notes, owner, next step, tasks |
| Tasks        | `/tasks`                        | Open follow-ups: overdue, today, later                                                         |
| Reports      | `/reports`                      | Funnel per pipeline, sources, KPIs                                                             |
| Go-to-market | `/gtm`                          | Strategies and the Partners (funds, universities…) we reach out to (docs/gtm.md)               |
| Knowledge    | `/knowledge`                    | FLF facts and messaging Claude reads before writing (docs/knowledge.md)                        |
| Events       | `/events`                       | Meetings with contacts, from the calendars via the portal sheet                                |
| Automations  | `/automations`                  | On/off switches, last run, recent runs; n8n workflows with status                              |
| Connections  | `/connections`                  | Every integration: status, what it feeds, settings, setup steps, Test                          |
| Health       | `/health`                       | Connections + automations + data freshness in one view, checked hourly                         |
| Admin        | `/admin/users`, `/admin/groups` | Roles, Sherpa flag, groups of permissions                                                      |

## Where things are

| Concern                               | Location                                                               |
| ------------------------------------- | ---------------------------------------------------------------------- |
| Pipelines (types, stages, follow-ups) | `functions/src/lib/crm/config.ts`                                      |
| Automations                           | `functions/src/lib/automations/config.ts` (list) + `index.ts` (code)   |
| Connections                           | `functions/src/lib/connections/config.ts` (list) + `index.ts` (checks) |
| Permissions                           | `functions/src/lib/permissions.ts`                                     |
| Callables                             | `functions/src/index.ts`: one `<feature>Action` dispatcher per feature |
| Rules / indexes                       | `firestore.rules`, `firestore.indexes.json`                            |
| Design tokens (FLF teal, Manrope)     | `src/app.css`                                                          |

The UI reads every list above through an action, so each is defined once, in `functions/`.

## Run locally

Node 24 (`.nvmrc`), Java 21 for the emulators, `npm i -g firebase-tools`.

```sh
npm install && (cd functions && npm install)
printf 'N8N_API_KEY=\nCHECKLY_API_KEY=\nFLF_MCP_KEY=%s\n' "$(openssl rand -base64 48)" > functions/.secret.local
printf 'FLF_HUB_URL=http://localhost:5002\n' > functions/.env.local
npm run emulators:start            # auth, functions, firestore (+ app on :5002)
node scripts/seed-emulator.mjs     # admin + sample data
```

Sign in at http://localhost:5002 as `admin@foundersforlifefellowship.com` / `flf-local-123`.

Behind an HTTP proxy, start the emulators with the proxy variables unset
(`env -u HTTPS_PROXY -u HTTP_PROXY firebase emulators:start …`): the emulator calls itself on
localhost and some versions send that through the proxy.

## Quality gates and CI

GitHub Actions (`.github/workflows/ci.yml`) runs all of this on every push and pull request to
`main`: lint, types, both builds, then `npm test` (the portal import against the Firestore
emulator, invented data, never a real project). Run the same locally before pushing:

```sh
npm run lint     # prettier + eslint
npm run check    # svelte-check
cd functions && npm run build
npm test         # needs Java 21 and the Firebase CLI
```

## Deploy

The web app is a static site on **Hostinger** (`hub.foundersforlifefellowship.com`); the backend
(Auth, Firestore, Cloud Functions) is **Firebase**.

### Firebase (once)

1. Create the project (Blaze plan: Cloud Functions need it), Firestore in `eur3`.
2. Authentication → Sign-in method: enable **Google only**. Settings → Authorized domains: add
   `hub.foundersforlifefellowship.com`, remove anything not used.
3. Google Cloud → APIs & Services → Credentials: restrict the browser API key to HTTP referrer
   `https://hub.foundersforlifefellowship.com/*`.
4. Secrets: `firebase functions:secrets:set` for `FLF_MCP_KEY`, `N8N_API_KEY` and `CHECKLY_API_KEY`
   A connection not set up yet gets `-` (or `unset`): Secret Manager can't store an empty value,
   and the code reads either as not configured.
5. `firebase deploy --only functions,firestore` (functions, rules and indexes).
6. Sign in once, set your `user/{uid}.role` to `admin` in the Firestore console, sign in again.

### Web app (every release)

```sh
cp .env.example .env.production    # fill in the web config from Firebase → Project settings
npm run build                      # writes build/, .htaccess included
```

Upload the **contents** of `build/` (including the hidden `.htaccess`) to the subdomain's folder
in Hostinger (File Manager or FTP), replacing what is there.
