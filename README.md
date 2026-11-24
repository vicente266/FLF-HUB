# FLF Hub

Internal hub of the Founders for Life Fellowship: CRM for Fellows, Gurus and Investors,
tasks, reports, automations, and the connections that feed them. SvelteKit + Firebase, the
same architecture as the EBS Hub (`barschool/aihub`).

## Modules

| Module      | Route                           | What it does                                                             |
| ----------- | ------------------------------- | ------------------------------------------------------------------------ |
| Home        | `/`                             | My tasks, contacts that need attention, KPIs, system health              |
| CRM         | `/crm`, `/crm/[id]`             | Pipelines per contact type (board + list), timeline, notes, owner, tasks |
| Tasks       | `/tasks`                        | Open follow-ups: overdue, today, later                                   |
| Reports     | `/reports`                      | Funnel per pipeline, sources, KPIs; Google Sheets as extra tabs          |
| Automations | `/automations`                  | On/off switches, last run, recent runs                                   |
| Connections | `/connections`                  | Every integration: status, what it feeds, settings, setup steps, Test    |
| Health      | `/health`                       | Connections + automations + data freshness in one view, checked hourly   |
| Admin       | `/admin/users`, `/admin/groups` | Roles, Sherpa flag, groups of permissions                                |

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
printf 'LEAD_WEBHOOK_TOKEN=local-token\nSLACK_WEBHOOK_URL=\nFLF_MCP_KEY=%s\n' "$(openssl rand -base64 48)" > functions/.secret.local
printf 'FLF_HUB_URL=http://localhost:5002\n' > functions/.env.local
npm run emulators:start            # auth, functions, firestore (+ app on :5002)
node scripts/seed-emulator.mjs     # admin + sample data
```

Sign in at http://localhost:5002 as `admin@foundersforlifefellowship.com` / `flf-local-123`.

Behind an HTTP proxy, start the emulators with the proxy variables unset
(`env -u HTTPS_PROXY -u HTTP_PROXY firebase emulators:start …`): the emulator calls itself on
localhost and some versions send that through the proxy.

## Quality gates

```sh
npm run lint     # prettier + eslint
npm run check    # svelte-check
cd functions && npm run build
```

## First deploy

1. Create the Firebase project `flf-hub` (Blaze plan), Firestore in `eur3`, Auth with
   Email/Password and Google enabled.
2. Create an App Hosting backend `flf-hub-backend`; store the web config as the
   `VITE_FIREBASE_*` secrets listed in `apphosting.yaml`.
3. `firebase functions:secrets:set LEAD_WEBHOOK_TOKEN`, `SLACK_WEBHOOK_URL` (empty is fine until
   Slack is set up) and `FLF_MCP_KEY` (see `docs/claude-connector.md`).
4. `firebase deploy`.
5. Sign in once, then in the Firestore console set your `user/{uid}.role` to `admin`, sign out
   and in. Create the groups (Default, Sherpas, Operations) in Admin → Groups.
6. Open Connections and follow each card's setup steps.
