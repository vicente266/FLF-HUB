# Claude connector (MCP)

Lets each person use and manage the FLF Hub from Claude (claude.ai, Claude Code). Ported from
the EBS Hub's My Work connector (`barschool/aihub`, `docs/my-work-mcp.md`, `functions/src/lib/my-work/mcp/`):
same OAuth design, same guardrails. Read that document for the full reasoning; this one lists what
is the same and what differs.

## What a person does

1. claude.ai → Settings → Connectors → **FLF Hub** (an Owner adds it once under Organization
   settings → Connectors → Add custom connector, with the address on the Hub's **Claude** page).
2. **Connect** opens the Hub's consent page (`/claude/connect`): sign in, confirm the password (or
   Google again), read which app asks and where it sends you back, **Approve**.
3. Claude can now read and change what the person's profile allows. Every change shows in the Hub
   as `<name> · via Claude` and is stored with `via: 'claude'`.
4. The **Claude** page lists the person's connections (**Disconnect**) and, for admins, everyone's
   (**Revoke**).

Claude Code: `claude mcp add --transport http --scope user flf-hub <address>`, then `/mcp`.

## How it is built

- `claudeMcp` (`functions/src/index.ts`) is one `onRequest` function: OAuth discovery documents,
  `/register`, `/authorize`, `/token` and `/mcp` (streamable HTTP, stateless, a new server per request).
- `functions/src/lib/mcp/`: `config.ts` (collections, lifetimes, limits), `crypto.ts` (keys from
  `FLF_MCP_KEY`), `oauth.ts` (clients, codes, rotating refresh tokens), `caller.ts` (who is calling,
  read fresh every call; rate limit; audit; nightly clean-up), `server.ts` (HTTP routes),
  `tools.ts` (the tools), `index.ts` (what `coreAction` calls).
- **The Hub is the OAuth issuer.** Registration is stateless (signed client ids). Redirects: only
  claude.ai/claude.com's callback or a loopback address. PKCE S256 required. Codes single use,
  60 s. Access tokens 1 h; refresh tokens rotate, 30 days; a connection ends 90 days after approval.
  Reusing an old refresh token ends the connection.
- **Claude acts as the person.** Every call re-reads the account (disabled? revoked?), the user doc
  (guest?) and the groups. The permission `claude.self.connect` is required, admins included (no
  bypass). Writes run the screens' own actions through `runAction` (`functions/src/dispatch.ts`),
  with the same gates and validation; reads check the same permission the screen needs.
- **Guardrails in code:** read tools are `readOnlyHint`, write tools are not (so Claude asks before
  each change), deletes are `destructiveHint`; text from the Hub is returned inside `<flf_data>`
  as data; 60 calls a minute per person; one audit doc per read (`uid`, `tool`, `ids`, `at`, never
  content), kept a year; one log line per call, never the text. Every page sends
  `frame-ancestors 'none'` and the consent page shows nothing inside a frame.

## Collections (none readable from the browser)

`mcpConnection` (one row per connection), `mcpCode` (sign-in codes), `mcpLimit` (one counter per
person), `mcpAudit` (reads, one year). Cleaned nightly by `automationsDaily`.

## Tools

| Read                                                                                                                                                                                                                                                                                                                                                                                          | Write                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `flf_overview` (start here), `flf_search_contacts`, `flf_get_contact`, `flf_list_tasks`, `flf_list_events`, `flf_list_team`, `flf_report` (funnel, sources, KPIs), `flf_health`, `flf_list_automations`, `flf_list_n8n_workflows`, `flf_list_connections`, `flf_list_groups` (admins), `flf_get_knowledge`, `flf_search_knowledge`, `flf_list_strategies`, `flf_list_skills`, `flf_get_skill` | `flf_create_contact`, `flf_update_contact`, `flf_move_stage`, `flf_undo_stage_move`, `flf_set_next_step`, `flf_assign_owner`, `flf_add_note`, `flf_create_task`, `flf_complete_task`, `flf_update_task`, `flf_delete_task` (destructive), `flf_delete_contact` (destructive, `crm.any.delete`), `flf_toggle_automation`, `flf_test_connection`, `flf_save_connection_settings`, `flf_import_portal` (dry run or sync of the portal sheet), `flf_set_user_access` (admins), `flf_save_knowledge`, `flf_delete_knowledge` (destructive), `flf_sync_knowledge`, `flf_report_knowledge_gap`, `flf_save_strategy`, `flf_delete_strategy` (destructive), `flf_save_skill`, `flf_delete_skill` (destructive), `flf_sync_skills` |

49 tools today (the six `flf_tv_*` tools are listed in docs/flf-tv.md; the five skills tools in docs/skills.md; how Claude reads Knowledge, with search, sections and gap reports, in docs/knowledge.md). A new Hub feature gets its tools here in the same change: reads check the screen's permission and
call `audit`; writes call the feature's action through `act()`.

## Differences from My Work

- Admin-only tools exist (`flf_set_user_access`, `flf_list_groups`): FLF asked to manage everything
  from Claude. They still require the caller's user doc to say `admin`, never the token claim.
- No private teams, so no read filter beyond permissions.
- `SCAN_LIMIT` (500): `flf_search_contacts` filters the newest 500 contacts of a type in code
  rather than a query per filter combination. Revisit (a real search index) past a few thousand contacts.

## Setup

1. `openssl rand -base64 48 | firebase functions:secrets:set FLF_MCP_KEY --data-file=-`
2. Deploy. Put `https://<claudeMcp host>/mcp` in `functions/.env` as `FLF_CONNECTOR_URL`, and the
   Hub's own address as `FLF_HUB_URL` if it is not `https://hub.foundersforlifefellowship.com`.
   Deploy again.
3. Admin → Groups: give `Claude — connect` to the groups that may use it.
4. Connections → Claude connector → Test.

## Tested on the emulator

Discovery and 401 header; foreign redirect refused; consent and approval; code single use; tokens;
At the time: 23 tools listed; read and write tools as an admin, writes shown "via Claude"; an invalid stage
refused with the screen's message; refresh rotation; forged refresh refused; a person without
`claude.self.connect` refused at approval; a revoked connection gets 401 on its next call; audit
docs hold only `at, ids, tool, uid`.
