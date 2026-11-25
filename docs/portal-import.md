# Portal sheet import

The FLF Portal's backend is the Google Sheet "FLF Portal Backend", written by the n8n workflow
"FFL Google Sheets" (webhook `ffl-portal`). **Both are production.** The Hub only READS the sheet:
it never writes to it, never calls the webhook and never runs, edits or publishes a workflow.

## What is read

| Tab            | Becomes                                                    | Notes                                                                                                                                                   |
| -------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CRM `         | Fellow contacts                                            | Stage: Targets → `target`, FOF – They are Aware → `aware`, FOF – Teaser Received → `teaser`, Fellows → `fellow`, Lost → `lost`. Status → next step.     |
| `Profiles`     | Fellow contacts (Role = Fellow only)                       | Cohort, pledge, Sherpa (→ owner when a team member has that name), archetype, location. Income → `fellowFinance` (restricted).                          |
| `Applications` | Fellow contacts in `application`                           | Only when the person is not already in the CRM tab or Profiles.                                                                                         |
| `Tasks`        | Tasks with no contact                                      | Owner matched by name; Done and Cancelled are done.                                                                                                     |
| `Perma`        | `wellbeing`                                                | Health data: permission `wellbeing.any.read`, served only through `portal:wellbeing.*`, **never to Claude**, no Firestore rule (browser can't read it). |
| `Wealth`       | `fellowFinance` totals per report and row type             | Permission `wealth.any.read`, never to Claude.                                                                                                          |
| `Events`       | `event` + a `meeting` entry on each participant's timeline | Written by n8n "Calendar → Events database". Participants (CRM names) matched to contacts by name. Events page, `flf_list_events`.                      |

Never read: `PasswordHash`, `Reset Token`, `Reset Expiry`, `Permissions`, `Read Versions`
(`TABS` in `functions/src/lib/portal/config.ts` lists the only columns read). Survey, Content
Base and Intro Request are not imported yet.

## How it runs

- **Preview import** (`portal:sync.plan`, Connections → FLF Portal sheet, or `flf_import_portal` in Claude):
  reads and reports counts, writes nothing.
- **Sync** (`portal:sync.run`, the same places, and the `portal-sync` automation at 03:00 once
  switched on): upserts by a stable id (hash of the email), so it can run any number of times.
  While the portal is live the sheet wins for the fields it owns; the Hub keeps its timeline, tasks
  and notes, and an owner set in the Hub. A stage change in the sheet is logged as "from the portal
  sheet".
- **Stage and next step: whichever changed last.** Each sync stores what the sheet said
  (`portal.sheetStage`, `portal.sheetNextStep`) and applies the sheet's value only when it differs
  from that, i.e. when someone changed that person in the sheet. A move made in the Hub stands
  until then. The sheet's Status column (Plan Interaction, Awaiting for Response) is the next step.
- New meetings from the last 14 days with a Target, Aware or Teaser contact give the owner a task
  "move to the next stage?" (automation `meeting-next-stage`) for its owner, or whoever last moved
  it in the Hub; nobody is moved automatically. A meeting also closes the contact's open "check in"
  task and clears "needs attention". A stage the sheet changes clears the Hub's loss reason.
- Sync writes set `portal.syncedAt`; `crmContactWritten` ignores them, so imports fire no
  follow-up or next-step task.
- **Health:** the FLF Portal sheet check reads every tab and reports a missing column (someone
  renamed or deleted one) before the import silently drops data.

## Setup

Share the sheet with the Functions service account as **Viewer** only. Locally, the emulator reads
a JSON fixture instead (`SHEETS_FIXTURE` in `functions/.env.local`).

## Tested on the emulator (fixture with invented people)

Dry run and sync: 7 contacts in the right stages, 3 tasks, 2 PERMA, 2 finance; second run creates
and moves nothing; no automation ran on imported contacts; no password hash or reset token reached
Firestore; Claude's `flf_get_contact` shows the portal fields but no PERMA or income.
