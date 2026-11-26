# Skills

One list of every skill FLF keeps for Claude and agents, with an automatic audit of each. A skill is
a Markdown file of instructions: a `SKILL.md`, a file under `.claude/skills/` or `.claude/commands/`,
or any Markdown file in a Skills folder. Built like Knowledge (docs/knowledge.md): same Drive import,
same table page, actions on `coreAction`.

## Sources

| Source     | What is listed                                                                                                                    | Edited                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **FLF TV** | The Clipping and Brand skills the TV worker reads (`tvSkill`, docs/flf-tv.md), as saved or built in.                              | In FLF TV → Skill (`/tv?tab=skill`). Read only here.                              |
| **Hub**    | Skills written on the Skills page: name, description, body (Markdown).                                                            | On the Skills page (Add skill, Edit, Delete), or by Claude with `flf_save_skill`. |
| **GitHub** | In each listed repo's default branch: `**/SKILL.md`, `.claude/skills/**/*.md`, `.claude/commands/*.md`, `skills/**/*.md`.         | In GitHub. Read only: the Hub uses a read-only token and only GET requests.       |
| **Drive**  | Markdown, text and Google Docs in the Skills folder, its subfolders (four levels) and shortcuts, as the Knowledge folder is read. | In Drive. Read only.                                                              |

The sources, patterns and limits are defined once, in `functions/src/lib/skills/config.ts`; the page
reads them through `core:skills.config.get`.

## The list

- One `skill/{id}` document per skill, id `<source>-<stable id>`: `tv-clipping`, `hub-<auto id>`,
  `github-<hash of repo and path>`, `drive-<file id>`. Fields: `name`, `description`, `body` (the
  whole file, up to 50,000 characters; `truncated` when cut), `source`, `location` (repo/path, Drive
  path, "Hub"), `url`, `updatedAt` (last change at the source: the file's last commit, Drive's
  modified time, the save), `importedAt`, `audit`, `nameKey` (the name in lower case, for the
  same-name check). GitHub skills also keep `repo`, `path`, `sha` and their relative `links`; Drive
  skills `driveModifiedTime`; FLF TV skills `tvKey` (the TV skill's version).
- **Name and description** come from the YAML front matter (`name:`, `description:`) when the file
  has them, else from the first heading and the first paragraph. A file that names itself nowhere is
  listed under its file name (its folder's name for a `SKILL.md`) and gets the "No name" error.
- At most 500 skills (settings-sized: read whole, without bodies, by `core:skills.list`), 200 files
  per repo and 200 from the Drive folder.
- Firestore: team read on `skill` (written only by `core:skills.*`). Queries: the whole collection
  with a field projection, and `nameKey ==` (single field, automatic): no composite index.

## Import (`core:skills.sync`)

**Sync now** on the Skills page, `flf_sync_skills`, and the `skills-sync` automation every night at
03:00 (in `portalNightly`, after the portal sheet and Knowledge).

- **FLF TV:** the two skills are rewritten only when the TV skill changed (its version, or a reset).
  The Skills list also refreshes them when it opens, so an edit in FLF TV shows at once.
- **GitHub:** per repo, `GET /repos/{repo}` (its default branch), `GET …/git/trees/{branch}?recursive=1`
  (every path), then for each skill file whose `sha` changed: its text (`contents` API, raw) and its
  last commit date (`commits?path=…&per_page=1`). A file whose sha didn't change is not read again;
  only its relative links are re-checked against the new tree.
- **Drive:** the Knowledge folder walk (`listDriveFolder` and `textOf`, exported from
  `functions/src/lib/knowledge/index.ts`), one export per changed file.
- **Removal:** a skill gone from a source read whole is deleted. A partial read deletes nothing and
  says why in the result: a repo unreachable, GitHub cutting the tree, over 200 files, a file that
  can't be read, an unshared shortcut, a folder too deep. A repo taken off the list loses its skills
  only when every listed repo was read whole.
- Each sync's result (files, new, updated, removed, not read) is stored on `connection/skills-github`
  and `connection/skills-drive` (`lastSync`) and shown on the page.
- Reads: the skill list once (twice when something changed); writes only for changed skills.

## The audit

`auditSkill()` in `functions/src/lib/skills/audit.ts` (pure, tested by `npm run test:skills`), run on
every import and save. Each finding is `{ level, code, message }`.

| Check                                                                                            | Level   |
| ------------------------------------------------------------------------------------------------ | ------- |
| Front matter malformed (not closed, not `key: value`, unquoted `: `, a key twice, an open quote) | error   |
| No name (no front matter `name`, no heading)                                                     | error   |
| No description                                                                                   | error   |
| Description doesn't start with "Use when" (two wordings: it says when, or not)                   | warning |
| Description over 1,024 characters (Claude's limit)                                               | error   |
| Description under 20 characters                                                                  | warning |
| Body empty                                                                                       | error   |
| Body over 500 lines                                                                              | warning |
| A relative link to a file that isn't in the same repo (GitHub only)                              | error   |
| The same name as another skill, any source, any case (whole list)                                | warning |
| Not updated in 180 days                                                                          | warning |

The same-name and 180-day checks are recomputed for the whole list after every sync (so a skill
nobody touches still turns stale), and for the names involved after a Hub save or delete.

## Actions (`coreAction`)

| Action              | Permission         | What                                                        |
| ------------------- | ------------------ | ----------------------------------------------------------- |
| `skills.config.get` | `skills.any.read`  | Sources, levels, patterns, limits, repos, folder, last sync |
| `skills.list`       | `skills.any.read`  | Every skill with its audit, no bodies                       |
| `skills.get`        | `skills.any.read`  | One skill with its body and parsed front matter             |
| `skills.save`       | `skills.any.write` | Create or edit a Hub skill                                  |
| `skills.delete`     | `skills.any.write` | Delete a Hub skill                                          |
| `skills.sync`       | `skills.any.write` | Import every source now                                     |

## Claude

`flf_list_skills` (filters `source`, `has_errors`) and `flf_get_skill` check `skills.any.read` and
write an audit doc; the body comes back inside `<flf_data>`, as data to read, not instructions.
`flf_save_skill`, `flf_delete_skill` (Hub skills only) and `flf_sync_skills` run the page's actions.

## Switching the sources on

1. **GitHub** (Connections → Skills on GitHub): create a fine-grained token with only the FLF repos
   and **Contents: Read-only**; `firebase functions:secrets:set GITHUB_SKILLS_TOKEN`; deploy; put the
   repos (one `owner/repo` per line, e.g. `vicente266/FLF`, `vicente266/FLF-Content`); Test. The
   token is only ever sent to `https://api.github.com` (fixed in code, redirects refused) and never
   logged. It is declared on `coreAction`, `connectionsAction`, `claudeMcp`, `healthHourly` and
   `portalNightly`, so it must exist in Secret Manager before the next deploy (a placeholder `-`
   reads as "not set up").
2. **Drive** (Connections → Skills folder): share the folder with
   900685987021-compute@developer.gserviceaccount.com as Viewer, put its folder id, Test.
3. Admin → Groups: give `Skills — view` (and `Skills — write and import` to who maintains them).
4. Skills → Sync now.
