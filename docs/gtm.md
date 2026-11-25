# Go-to-market

The organisations FLF sells to or partners with (VC funds, universities, accelerators, corporates,
foundations), grouped by strategy.

## Partners (in the CRM)

- A fourth contact type, **Partner**, with its own pipeline: Targets → Contacted → In conversation →
  Proposal → Partners / Lost (follow-up task per stage, as for the other types). Defined in
  `functions/src/lib/crm/config.ts`.
- On a Partner, **company is the organisation** (required) and **name is the main contact**
  (optional; empty until there is one). Screens title a Partner by its organisation, and tasks and
  messages use the main contact's name or, without one, the organisation (`displayName`). Email,
  phone and LinkedIn are the main contact's. Other contact types still need a name.
- `segment` and `strategyId` are only stored on Partners; the strategy is checked only when it
  changes, so a Partner whose strategy was deleted can still be edited.
- `segment` (one of `SEGMENTS`: VC fund, university, …) and `strategyId` (a strategy).
- Discussion notes are timeline notes; the next step ("Plan Interaction", "Awaiting for Response")
  and tasks work as for every contact.

## Strategies

- `strategy/{id}`: `name`, `segment`, `status` (active, paused, done), `description` (the approach:
  who, the pitch, the offer, how we reach them), `createdAt`, `updatedAt`, `updatedBy`.
- Written through `crm:strategy.save` and `crm:strategy.delete` (permission `crm.any.write`);
  deleting one unlinks its Partners, it never deletes them.
- **Go-to-market page** (`/gtm`): each strategy with its funnel (Partners per stage) and its
  organisations (stage, main contact and email, next step, owner, last activity); Partners without a
  strategy in their own group.
- **Claude:** `flf_list_strategies` (strategies with Partners per stage), `flf_save_strategy`,
  `flf_delete_strategy`; Partners through the contact tools with `type: "partner"`, `segment` and
  `strategy_id`.

## Updating a contact

`crm:contact.update` changes only the fields it is sent; the others keep their value (send `""` to
clear one). The screen sends every field; Claude's `flf_update_contact` sends only what it changes.
Strategy and Knowledge edits work the same way. Reads this adds: one read of the contact per update
(plus one of the strategy when it changes), one read of the strategy or entry per edit, and a
strategy delete reads its linked Partners in pages of 400.

## Automation tasks (all contact types)

- A task goes to the contact's **owner**, or, without one, to **whoever last created it, moved its
  stage or set its next step in the Hub** (`changedByUid`). With neither, no task is made; a stale
  contact is still flagged "needs attention".
- Each automation task stores its `automationId`. Entering a stage closes the open tasks of the
  previous stage (follow-up, meeting suggestion, stale check-in); a new next step closes the previous
  next-step task; a note or a meeting closes the stale check-in. Closed ones stay as done, marked
  `superseded`. Manual, Claude and portal tasks are never closed this way.
- Each handler re-reads the contact and does nothing if it already moved on (two quick moves).
- Moving to a losing stage (Lost, Declined) asks for the reason: stored as `lostReason`, shown on the
  contact and its timeline, cleared when it leaves that stage.
- Reads this adds: one query of the contact's open tasks per Hub create, stage move, next-step
  change, note and meeting; one read of the contact per stage or next-step change.
