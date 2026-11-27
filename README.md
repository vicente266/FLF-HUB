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
| Skills       | `/knowledge?tab=skills`         | Every skill for Claude and agents (FLF TV, Hub, GitHub, Drive), audited (docs/skills.md)       |
| Events       | `/events`                       | Upcoming meetings from Google Calendar (docs/calendar.md), past ones via the portal sheet      |
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
printf 'FLF_HUB_URL=http://localhost:5002\nFLF_CONNECTOR_URL=http://127.0.0.1:5001/demo-flf-hub/europe-west4/claudeMcp/mcp\n' > functions/.env.local
cp .env.example .env.local         # then fill it as below
npm run emulators:start            # auth, functions, firestore, as the demo-flf-hub project
node scripts/seed-emulator.mjs     # admin + sample data
npm run emulate                    # the app on :5002
```

`.env.local` for the app: `VITE_FIREBASE_PROJECT_ID=demo-flf-hub`, any non-empty value for the
other `VITE_FIREBASE_*`, and the emulator lines from `.env.example` uncommented.

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

### Automatic deploy (GitHub Actions)

`.github/workflows/deploy.yml` deploys `main` after CI passes; each part is skipped until its
secrets exist (repo → Settings → Secrets and variables → Actions). Run it by hand from the
Actions tab (**Deploy → Run workflow**).

- **Web (Hostinger):** secrets `HOSTINGER_FTP_SERVER`, `HOSTINGER_FTP_USERNAME`,
  `HOSTINGER_FTP_PASSWORD` (hPanel → Files → FTP Accounts; an account limited to the hub.
  folder is safest). Variables `VITE_FIREBASE_*` (as in `.env.example`) and, when the FTP
  account's root is not the hub. folder, `HOSTINGER_FTP_DIR`.
- **Backend (Firebase):** keyless, through Workload Identity Federation (the organisation forbids
  service-account keys). Repo variables `FIREBASE_WIF_PROVIDER`
  (`projects/900685987021/locations/global/workloadIdentityPools/github/providers/github`) and
  `FIREBASE_DEPLOY_ACCOUNT` (`github-deploy@flfhub.iam.gserviceaccount.com`). The pool only
  accepts this repository's `main`; the account has Firebase Admin, Cloud Functions Admin, Cloud
  Run Admin, Service Account User, Secret Manager Viewer, Artifact Registry Administrator and
  Cloud Scheduler Admin. New Secret Manager secrets are still created by hand
  (`firebase functions:secrets:set`) before the deploy that needs them.
- **Monitoring (Checkly):** secrets `CHECKLY_API_KEY` (Checkly → User settings → API keys) and
  `CHECKLY_ACCOUNT_ID` (Checkly → Account settings → General); optional variable
  `CHECKLY_ALERT_EMAIL` for a failure email. See "Monitoring".

## One-off data changes

A change to the live data that no screen makes (a backfill, a fix, a record set up for someone) is a
file in `ops/changes/` (`YYYY-MM-DD-what.mjs`, default export `(db, FieldValue) => summary`).
Pushing it to `main` runs `.github/workflows/hub-data.yml`, which applies each file once, as the
deploy account, and records it in `opsApplied/{file}`. Never edit a file that has run; add a new one.

## Monitoring

Checkly watches from outside on the free Hobby plan. The URL monitors (website, portal login,
Hub) are set up in Checkly by hand. The browser check in `checkly/` is code, deployed by the
Deploy workflow: every hour, from one location, it opens the Hub signed out and fails if the app
doesn't start, doesn't reach the sign-in page or logs an error. It can't see bugs behind sign-in
(sign-in is Google only). Health shows every check's pass/fail through the `checkly` connection.
