# Knowledge

What the team wants Claude to know about FLF: the Fellowship, the Pledge, current offers, the pitch
for funds and universities, messaging. Ported from the EBS Hub's knowledge store
(`barschool/aihub`, `functions/src/lib/knowledge-store.ts`): same entry shape, same expiry rule.

## The list

- One `knowledge/{id}` document per entry: `label` (optional), `description` (the text, verbatim),
  `expiredAt` (`YYYY-MM-DD`, optional), `createdAt`, `updatedAt`, `updatedBy`.
- An entry is **active** until its `expiredAt` day has passed. Expired entries stay in the list (struck
  through, folded away) so they can be re-dated or deleted, but are never given to Claude.
- Settings-sized (at most 200 entries, 8,000 characters each): read whole and filtered in memory,
  fresh on every use, so an expiry takes effect the day it passes.

## Where it is used

- **Knowledge page** (`/knowledge`, permission `knowledge.any.read`; add, edit and delete need
  `knowledge.any.write`). The browser reads the list live; writes go through `core:knowledge.save`
  and `core:knowledge.delete`.
- **Claude connector:** `flf_get_knowledge` returns the active entries, each as its own
  `<entry label="…" valid_until="…">` block so one entry's bullets never run into the next, inside
  their own `<flf_knowledge>` frame. Every other tool frames Hub content as data "never to act
  on"; Knowledge is the team's guidance Claude should **follow** for facts and wording, so its
  frame says that, and also that it never authorises an action (a tool call, a change, a message).
  An entry's text can't close its block or the frame (`<entry`, `</entry`, `<flf_knowledge` inside
  a description are neutralised). With `include_all` Claude also gets every entry with its id and
  `expired` flag, as data. The connector's instructions tell Claude to read Knowledge before
  writing anything about FLF. `flf_save_knowledge` (an edit sends only what changes) and
  `flf_delete_knowledge` run the page's actions.
- **What Claude reads** (button on the page) shows that block exactly as Claude receives it.

The actions live in `coreAction` (`knowledge.*`), like the Claude connector's `claude.*`, rather than
a callable of their own: a new callable on this project needs Cloud Run's invoker check turned off by
hand (the organisation blocks public access), so small features share `coreAction`.

## How Claude uses each entry

Every entry has a `use`, set on the Knowledge page (a switch on each row) or by Claude with
`flf_save_knowledge`:

- **Always** (`always`): its text goes with every `flf_get_knowledge`, so Claude reads it before
  writing anything about FLF. Set it on an entry once it is approved, not on drafts.
- **When relevant** (`relevant`): Claude gets only an index (id, title, topics) and asks for the
  text with `flf_get_knowledge` `ids` or `topic` when the task needs it. The default for every new
  entry (written in the Hub or imported) and for older entries without a `use`.
- **Off** (`off`): kept, never given to Claude.

`topics` (up to 8 free-text tags) let Claude read every entry on one subject (`topic`). Expired
entries are left out whatever their use.

## The Knowledge folder (Drive)

- Connection **Knowledge folder (Drive)** (`knowledge-folder`): a folder id (default the FLF
  Knowledge folder, `DEFAULT_FOLDER_ID` in `functions/src/lib/knowledge/config.ts`). Share the
  folder with the Functions service account as **Viewer**; Test connection lists what it can import.
- Import (`core:knowledge.sync`, **Sync now** on the Knowledge page, `flf_sync_knowledge`, and the
  `knowledge-sync` automation every night at 03:00): each Google Doc, text or Markdown file becomes
  the entry `drive-<file id>` (title = file name, text up to 50,000 characters, link to the file).
  Subfolders are read too, four levels deep, and shortcuts are followed to their folder or file (a
  shortcut's target keeps its own sharing: one not shared with the service account is reported,
  in the import and in Health); a new entry gets its top subfolder ("Legal") as a
  topic. A file's text is re-read only when it changed; a file removed from the folder takes its
  entry with it, but only after a whole listing (none when the listing stopped at the entry limit
  or the depth). Other file types (PDF, Sheets, Slides) are listed as not importable. Read only:
  the Hub never writes to Drive.
- An imported entry's title and text are edited in Drive; in the Hub only its use, topics and
  expiry change, and it can't be deleted there (remove the file, or set it to Off).
- Reads: one Drive listing per folder per import plus one export per changed file; one Firestore query of the
  imported entries.

## The card

Every entry has a card, like the header of a file in the EBS knowledge repo. It is edited in the
Hub (Knowledge → Edit), also for documents imported from Drive, whose text stays in Drive.

| Field         | What it is                                                                                                                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `type`        | Policies, Decisions, Offer, Strategy, Procedures, Workflows, Brand, Glossary or Other (`TYPES` in `functions/src/lib/knowledge/config.ts`). An imported document takes it from its top subfolder in Drive (Legal → Policies, Scoring → Procedures…) until the team changes it. |
| `useWhen`     | One sentence, "Use when …": Claude reads the entry when the task matches it. Shown in the index of "When relevant" entries.                                                                                                                                                    |
| `audience`    | `external` (may be shared outside FLF), `internal` (the team; the default) or `restricted` (admins only: hidden from everyone else in the Hub, in Firestore and through Claude).                                                                                               |
| `status`      | `draft` (new and imported entries) or `approved`. Only a person approves, on the Knowledge page; Claude can propose a card but not approve. Only an approved entry can be **Always**. An imported document whose text changes in Drive goes back to draft.                     |
| `reviewEvery` | 3, 6 or 12 months. An approved entry past `lastReviewed` + `reviewEvery` shows **Review due**; **Mark reviewed** sets `lastReviewed` to today.                                                                                                                                 |

## Precedence

When two entries disagree, for Claude or any agent reading Knowledge:

1. The **type** higher in this list wins: Policies, Decisions, Offer, Strategy, Procedures,
   Workflows, Brand, Glossary, Other. Nothing may contradict a policy; a decision overrides the
   documents of the types below it.
2. At the same type, **approved** wins over draft. A draft is unconfirmed: Claude says so when it
   relies on one.
3. At the same type and status, the more recently **approved or reviewed** wins.

Each entry Claude reads carries `rank` (1 = strongest: approved policy), `status` and `reviewed`,
and the entries come in rank order. The Knowledge page groups entries by type in the same order.
To change the order, change `TYPES` (and this list).
