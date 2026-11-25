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
