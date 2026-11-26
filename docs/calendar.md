# Calendar (upcoming meetings)

Events → **Upcoming** lists the next 30 days of meetings from the team's Google Calendars, with each
guest matched to a CRM contact by email. Past meetings still come from the portal sheet's Events tab
(docs/portal-import.md); the two are separate.

## What a person does

1. In Google Calendar → Settings → the calendar → **Share with specific people**: add
   `900685987021-compute@developer.gserviceaccount.com` with **See all event details**.
2. Connections → **Calendar**: put the calendar ids, one per line (a person's calendar id is their
   email address), save, press **Test**. The test reads each calendar's next 7 days.

Until a calendar id is saved, Events → Upcoming says "Connect a calendar in Connections → Calendar"
with a link to `/connections?open=calendar`, and Health shows the connection as needing setup.

## How it is built

- `functions/src/lib/calendar/index.ts`. Read only: Google Calendar API v3 `events.list` (GET),
  Application Default Credentials with the `calendar.readonly` scope, `singleEvents=true`,
  `orderBy=startTime`, at most 100 events per calendar.
- `crm:events.upcoming` (`crm.any.read`) and Claude's `flf_list_upcoming_meetings` (same permission,
  one audit doc per call) return the same list: title, start, end, all-day, location, Meet link,
  guests (the configured calendars themselves and rooms left out) and the calendar id. One meeting in
  several team calendars is listed once.
- **Nothing is stored in Firestore.** The result is cached in memory per function instance for
  5 minutes (not after a calendar failed to read), so reloading the page costs no new reads.
- **Read cost per uncached call:** 1 read (the connection's settings) + for every 30 distinct guest
  emails, two queries (`email in […]` and `otherEmails array-contains-any […]`): 1 read each when
  nothing matches, otherwise 1 per contact found. 60 guests with 10 known contacts ≈ 1 + 4 + 10 = 15
  reads.
- The connection check (`check()` in `connections/index.ts`, hourly with the others) reads each
  calendar's next 7 days: a calendar that is not shared reports "Not shared with the Hub".
