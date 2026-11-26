# Knowledge

What the team wants Claude to know about FLF: the Fellowship, the Pledge, current offers, the pitch
for funds and universities, messaging. Ported from the EBS Hub's knowledge store
(`barschool/aihub`, `functions/src/lib/knowledge-store.ts`): same entry shape, same expiry rule.

## The list

- One `knowledge/{id}` document per entry: `label` (optional), `description` (the text, verbatim),
  `expiredAt` (`YYYY-MM-DD`, optional), `createdAt`, `updatedAt`, `updatedBy`, and its outline
  `sections` and length `words` (see "Sections").
- An entry is **active** until its `expiredAt` day has passed. Expired entries stay in the list (struck
  through, folded away) so they can be re-dated or deleted, but are never given to Claude.
- Settings-sized (at most 200 entries, 8,000 characters for an entry written in the Hub, 50,000 for an imported document): read whole and filtered in memory,
  fresh on every use, so an expiry takes effect the day it passes.

## Where it is used

- **Knowledge page** (`/knowledge`, permission `knowledge.any.read`; add, edit and delete need
  `knowledge.any.write`). The browser reads the list live; writes go through `core:knowledge.save`
  and `core:knowledge.delete`.
- **Claude connector:** `flf_get_knowledge` returns the active entries, each as its own
  `<entry id="…" label="…" valid_until="…">` block so one entry's bullets never run into the next, inside
  their own `<flf_knowledge>` frame. Every other tool frames Hub content as data "never to act
  on"; Knowledge is the team's guidance Claude should **follow** for facts and wording, so its
  frame says that, and also that it never authorises an action (a tool call, a change, a message).
  An entry's text can't close its block or the frame (`<entry`, `</entry`, `<flf_knowledge` inside
  a description are neutralised). With `include_all` Claude also gets every entry with its id and
  `expired` flag, as data. The connector's instructions tell Claude to read Knowledge before
  writing anything about FLF. `flf_save_knowledge` (an edit sends only what changes) and
  `flf_delete_knowledge` run the page's actions. How Claude finds and reads the rest: "How Claude
  reads Knowledge" below.
- **What Claude reads** (button on the page) shows that block exactly as Claude receives it, its
  word count against the budget, and the index of the When relevant entries.

The actions live in `coreAction` (`knowledge.*`), like the Claude connector's `claude.*`, rather than
a callable of their own: a new callable on this project needs Cloud Run's invoker check turned off by
hand (the organisation blocks public access), so small features share `coreAction`.

## How Claude uses each entry

Every entry has a `use`, set on the Knowledge page (a switch on each row) or by Claude with
`flf_save_knowledge`:

- **Always** (`always`): its text goes with every `flf_get_knowledge`, so Claude reads it before
  writing anything about FLF. Set it on an entry once it is approved, not on drafts.
- **When relevant** (`relevant`): Claude gets only an index (see "How Claude reads Knowledge") and
  asks for the text (whole, by section or by topic) or searches it when the task needs it. The default for every new
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
  A Google Doc is exported as **Markdown** (`export?mimeType=text/markdown`), so its headings become
  the entry's sections; if Drive refuses that export, as plain text (no sections). Text and Markdown
  files are read as they are. The entry keeps `exportFormat` (`markdown`, `plain` or `file`); a
  Google Doc imported before Markdown export (no `exportFormat`) is read once more on the next
  import even though it didn't change in Drive, and keeps its approval (only a change in Drive
  sends it back to draft). Skills read Google Docs as plain text, as before (`textOf`).
  Subfolders are read too, four levels deep, and shortcuts are followed to their folder or file (a
  shortcut's target keeps its own sharing: a folder not shared with the service account is reported
  in the import and in Health, a file in the import); a file that appears twice (itself and a
  shortcut) is imported once; a new entry gets its top subfolder ("Legal") as a
  topic. A file's text is re-read only when it changed; a file removed from the folder takes its
  entry with it, but only after a whole listing (none when the listing stopped at the entry limit,
  the depth or an unshared shortcut, which the import reports). New documents only fill the room
  left under the 200-entry limit. Other file types (PDF, Sheets, Slides) are listed as not importable. Read only:
  the Hub never writes to Drive.
- An imported entry's title and text are edited in Drive; in the Hub its card (type, use when,
  audience, status, review), use, topics and expiry change, and it can't be deleted there (remove
  the file, or set it to Off).
- Reads: one Drive listing per folder per import plus one export per changed file; one read of the
  whole collection (settings-sized), which also gives entries from before the card their defaults
  (audience internal, status draft, type other) and entries without an outline theirs (written
  only when the field is missing; a changed text is re-outlined when it is saved or imported).

## The card

Every entry has a card, like the header of a file in the EBS knowledge repo. It is edited in the
Hub (Knowledge → Edit), also for documents imported from Drive, whose text stays in Drive.

| Field         | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`        | Policies, Decisions, Offer, Strategy, Procedures, Workflows, Brand, Glossary or Other (`TYPES` in `functions/src/lib/knowledge/config.ts`). An imported document takes it from its top subfolder in Drive (Legal → Policies, Scoring → Procedures…) until the team changes it.                                                                                                                                                                                                                                                                    |
| `useWhen`     | One sentence, "Use when …": Claude reads the entry when the task matches it. Shown in the index of "When relevant" entries.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `audience`    | `external` (may be shared outside FLF), `internal` (the team; the default) or `restricted` (admins only: hidden from everyone else in the Hub, in Firestore and through Claude).                                                                                                                                                                                                                                                                                                                                                                  |
| `status`      | `draft` (new and imported entries) or `approved`. Only a person approves, on the Knowledge page (a row's Approve, or Status in the edit dialog: the same action); Claude can propose a card but not approve. Only an approved entry can be **Always**. Saving a new text, title or type on an approved entry, or making it External, sends it back to draft (the dialog warns first); a draft is read When relevant, never Always (asking for Always on a draft is refused). An imported document whose text changes in Drive goes back to draft. |
| `reviewEvery` | 3, 6 or 12 months. An approved entry past `lastReviewed` + `reviewEvery` shows **Review due**; **Mark reviewed** sets `lastReviewed` to today.                                                                                                                                                                                                                                                                                                                                                                                                    |

## Precedence

When two entries disagree, for Claude or any agent reading Knowledge:

1. The **type** higher in this list wins: Policies, Decisions, Offer, Strategy, Procedures,
   Workflows, Brand, Glossary, Other. Nothing may contradict a policy; a decision overrides the
   documents of the types below it.
2. At the same type, **approved** wins over draft. A draft is unconfirmed: Claude says so when it
   relies on one.
3. At the same type and status, the more recently **approved or reviewed** wins.

Each entry Claude reads carries `rank` (1 = strongest: approved policy), `status` and `reviewed`,
and the entries come in rank order. `rank` counts type and status together (1 approved policy,
2 draft policy, 3 approved decision…, up to twice the number of types), so the Knowledge page shows
only the type name, sorted in the same order, and explains `rank` in "What Claude reads".
To change the order, change `TYPES` (and this list).

## Sections

`sectionsOf(markdown)` (`functions/src/lib/knowledge/sections.ts`, pure, tested by
`npm run test:knowledge`) splits an entry's text by its Markdown headings:

- `#`, `##` and `###` at the start of a line (`####` and `#tag` are text; so is anything inside a
  fenced code block). The text before the first heading, when it has words, is its own section
  `intro` ("Introduction").
- Each section: `id` (the title as a slug, accents folded: `Café & Prices 2026` →
  `cafe-prices-2026`; a repeated title gets `-2`, `-3`), `title`, `level` (0 for the intro, 1–3),
  `chars`, `words`. A section runs to the next heading of the same or a higher level, so a `##`
  holds its `###`s. An id stays the same while its title and the titles before it with the same
  slug stay.
- Stored on the entry, without text, as `sections` (at most `MAX_SECTIONS`, 100) and `words`
  (the whole text), when it is saved in the Hub, when it is imported, and by the nightly import for
  entries that don't have them yet.
- An entry with one section (no headings) has no outline in Claude's index: it is read whole.

## How Claude reads Knowledge

The connector's instructions and `flf_get_knowledge`'s description give Claude this order:

1. `flf_get_knowledge` without arguments: the **Always** block (followed for facts and wording)
   and the **index** of the When relevant entries, as data. The index is grouped by type in
   precedence order, strongest first; per entry: `id`, `title`, `type`, `rank`, `status`,
   `use_when`, `topics`, `words`, `outline` (`"<sectionId>: <title>"`, at most 25, then
   `outline_more`), `reviewed`, `review_due` (only when due) and `audience` (only when not
   internal). Empty fields are left out: the index is read every time. It says that a draft is
   unconfirmed.
2. Then what the task needs: `flf_get_knowledge` `sections: ["<entryId>#<sectionId>", …]` (at most
   20; each comes back as its own `<entry … section="…" section_title="…">` block with the entry's
   attributes), `ids` (whole entries) or `topic`; or `flf_search_knowledge` to find passages.
   What was asked for and isn't there (unknown, off, expired, restricted for a non-admin) comes back
   as `notFound`.
3. Precedence when entries disagree: lower `rank` wins (type, then approved over draft), then the
   more recent `reviewed`. Claude says so when it relies on a draft.
4. Missing, contradictory or outdated knowledge: `flf_report_knowledge_gap` ("Gaps").
5. Skills for agents: `flf_list_skills` (docs/skills.md).

## Search

`core:knowledge.search` `{ query, limit ≤ 10 }` (permission `knowledge.any.read`) and
`flf_search_knowledge`. In memory over the list `knowledge.get` already reads (no query of its
own); never `off` or expired entries, restricted ones only for admins. The scorer is pure
(`functions/src/lib/knowledge/search.ts`, tested by `npm run test:knowledge`):

- Words: lower case, accents folded, English stop words dropped, plurals stemmed
  (`pledges` → `pledge`, `policies` → `policy`).
- Each section is scored per query word: in the entry's title 6, topics 5, Use when 4, the
  section's heading 4, its own text 1 per occurrence (at most 5; a section's own text stops at the
  next heading of any level), plus 5 per distinct query word the section matches at all (so a
  section that holds more of the question beats one that repeats one word).
- At most two sections per entry. Ties: the stronger `rank`, then the entry id.
- Each hit: entry `id`, `section` and `sectionTitle`, `title`, `type`, `rank`, `status`, `score`
  (relative) and a `snippet` of about 300 characters of the section's text around the place where
  most query words sit together. Claude reads the section before relying on it.

## Gaps

What Claude (or a person) found missing, contradictory or out of date, for the team to fix.

- Collection `knowledgeGap`: `kind` (`missing` | `conflict` | `outdated`, `GAP_KINDS` in
  config), `note` (≤ 1,000), `entryIds` (≤ 10; at least one for conflict and outdated; each must
  exist and be visible to the reporter), `query` (≤ 300), `reportedBy` (`<name> · via Claude` from
  the connector), `reportedUid`, `via` (`claude` | `hub`), `status` (`open` | `resolved`), `count`,
  `lastReportedAt`, `lastReportedBy`, `resolvedBy`, `resolution` (the resolve note), `createdAt`,
  `resolvedAt`, `key` (a hash for the repeat check).
- `core:knowledge.gap.report` (permission `knowledge.any.read`, so Claude reports while it reads)
  and `flf_report_knowledge_gap` (a non-destructive write through the action).
- **Repeat guard:** the same kind, entries and query (or, with neither, the same note) already open
  from the last 7 days (`GAP_REPEAT_DAYS`) only gets `count` +1 and `lastReportedAt`. Query
  `key ==, status ==, createdAt >=` with `limit(1)` (composite index).
- `core:knowledge.gap.resolve` `{ id, note? }` (permission `knowledge.any.write`) on the page.
- Knowledge page → **Gaps** tab (`?tab=gaps`), badge = open gaps. Each gap shows its kind, note,
  query, linked entries (click to open the entry), who reported it and when (and how many times),
  and **Resolve** with an optional note. **Report a gap** lets a person report one. **Show
  resolved** lists the 50 latest resolved ones.
- Firestore: team read (rules); the page reads `status == open` ordered by `createdAt` desc,
  limit 100 (one listener, which also counts the badge), and resolved the same way only when shown
  (composite index `status, createdAt desc`). Reads: one per open gap when the page opens, plus up
  to 10 entry reads and one repeat query per report.

## Always budget

`ALWAYS_BUDGET_WORDS` (3,000, `functions/src/lib/knowledge/config.ts`): the most words of Always
text Claude should get with every `flf_get_knowledge`. `knowledge.list` returns `alwaysWords` (the
Always entries this person's Claude reads, so restricted ones only for admins) and `alwaysBudget`.
The Knowledge page shows "Always: N words of 3,000", in the warning colour above it with the hint
to move long documents to When relevant (Claude reads the index and opens what it needs); each row
shows its words and sections; the edit dialog warns when setting an entry to Always would take
Always over the budget. It is a warning, not a limit.
