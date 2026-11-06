# Hotwire Robotics schedule (web-cal)

The team's 2027 meeting and competition schedule (Jan 10 – May 1, 2027), published on GitHub Pages as:

| What | Where |
| --- | --- |
| Schedule page (calendar + subscribe buttons) | https://hotwirerobotics.github.io/web-cal/ |
| Full calendar feed (meetings, TBD days, competitions) | https://hotwirerobotics.github.io/web-cal/calendar.ics |
| Competitions-only feed | https://hotwirerobotics.github.io/web-cal/competitions.ics |

Everything comes from one file, [`schedule.json`](schedule.json). A GitHub Action turns it into the website and
the `.ics` feeds every time it changes, so subscribed calendars pick up edits on their next refresh.

## One-time setup

1. **Turn on Pages:** repository **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. **Run the deploy:** **Actions → Build and deploy calendar → Run workflow** (or push any commit).
   The first run before step 1 fails at the deploy step. That's expected; just run it again.

## Updating the schedule

1. Open [`schedule.json`](schedule.json) on GitHub and click the pencil icon (**Edit this file**).
2. Make the change (see [the format](#schedulejson-format) below), then click **Commit changes**.
3. The Action checks the file, rebuilds the site and feeds, and publishes them in about a minute.

If something in the file is wrong (a typo in a date, a missing comma, a meeting that ends before it starts), the
Action fails with a list of the problems and the live site stays as it was. GitHub notifies whoever made the
commit; the list is under **Actions → the failed run → build → Test**. Fix the file and commit again.

## Subscribing

The public page has one-click buttons for Apple Calendar (iPhone/Mac) and Google Calendar, plus a link to copy for
Outlook and other apps. Calendar apps re-check subscriptions on their own schedule: Apple and Outlook usually
within an hour or two, Google Calendar sometimes up to a day.

## The website

The schedule page shows a month calendar ([SimpleCalendarJS](https://www.simplecalendarjs.com)). It opens on the
current month (or the first or last month of the schedule outside the season).

- **Blue** – meetings, with their start time · **Amber** – meeting days whose time is still TBD
- **Red** – competitions the team attends · **Gray** – other weeks of the season
- **Pastel bars** – no-school days, in the colors from `schedule.json`

Hovering over an entry (or tapping it on a phone) shows its times, location, and notes. Clicking a date opens that day.
Times are shown as written in `schedule.json` (Pacific), whatever time zone the viewer's device is in.

## How the feed is built

- **Meetings** become timed events ("Robotics Meeting", 6–9 PM Pacific). On competition days they take the
  competition's name.
- **TBD days** become all-day "Robotics Meeting (time TBD)" entries. They turn into timed events once a time is set.
  On days already covered by a competition they're skipped. A setting turns them off entirely.
- **Off and blank days** are left out.
- **Competitions the team attends** are multi-day all-day events.
- No-school notes, day notes, and a link back to the schedule go in each entry's description.
- Every entry has a stable ID (by date, or by event id), so edits update existing entries in people's calendars
  instead of creating duplicates.

## `schedule.json` format

```jsonc
{
  "version": 1,
  "calendar": { "name": "...", "timezone": "America/Los_Angeles", "seasonStart": "2027-01-10", "seasonEnd": "2027-05-01", ... },
  "tags":   [ { "id": "stayton", "label": "No School Stayton", "color": "#f5c8a2" } ],
  "events": [ { "id": "week-2", "title": "Wilsonville (Week 2)", "start": "2027-03-12", "end": "2027-03-14", "attending": true } ],
  "days": {
    "2027-01-11": { "status": "meeting", "start": "18:00", "end": "21:00" },
    "2027-01-14": { "status": "off" },
    "2027-03-29": { "status": "tbd", "tags": ["stayton"], "notes": "optional" }
  }
}
```

Dates are `YYYY-MM-DD`. Times are 24-hour `HH:MM` (`18:00` is 6 PM) in the calendar's time zone.

**`days`** – one entry per date, keyed by the date:

| Field | |
| --- | --- |
| `status` | `"meeting"`, `"tbd"` (meeting, time not set yet), or `"off"` |
| `start`, `end` | Meeting times. Required for `"meeting"` |
| `title` | Optional. Replaces "Robotics Meeting" (e.g. `"2027 BioCore FRC Kickoff"`) |
| `location`, `notes` | Optional. Shown on the website and in the calendar entry |
| `tags` | Optional. No-school colors for the day, by `id` from `tags` (e.g. `["stayton", "cascade"]`) |

Days can be any date, including ones before `seasonStart` or after `seasonEnd` (kickoff, summer demos, …).
Dates that aren't listed are simply blank.

**`events`** – competitions and other multi-day events. `id` must be unique and shouldn't change once people have
subscribed (it's how calendar apps recognize the event). `end` is the last day, inclusive. `"attending": false` shows
the event on the website only. `location` and `notes` are optional.

**`tags`** – no-school colors: an `id` used in `days`, the `label` shown, and a `#rrggbb` `color`.

**`calendar`** – `name`, `description`, `url` (optional link added to each calendar entry), `timezone`,
`seasonStart`, `seasonEnd`, `meetingTitle`, `meetingLocation` (used for regular meetings), `tbdTitle`, and
`includeTbd` (`false` leaves TBD days out of the feed).

The file is JSON, so watch for commas: one between items, none after the last item in a list or `{ }`.
Keeping one line per day (as it is now) makes changes easy to review, but any layout works.

## Development

Plain HTML, CSS, and JavaScript with no bundler or framework. Requires Node 22+.

```bash
npm ci           # installs the libraries below, at the exact versions in package-lock.json
npm test         # validates schedule.json and the feed generator
npm run serve    # builds into _site/ and serves it at http://localhost:8080
```

### Libraries

| Library | Used for | License |
| --- | --- | --- |
| [Luxon](https://moment.github.io/luxon/) | All date, time, and time zone handling | MIT |
| [ical-generator](https://github.com/sebbo2002/ical-generator) | Writing the `.ics` feeds (escaping, line folding, all-day vs. timed events) | MIT |
| [SimpleCalendarJS](https://www.simplecalendarjs.com) | The month calendar on the website | Free for personal, educational, and non-commercial use ([terms](https://github.com/pclslopes/SimpleCalendarJs/blob/main/LICENSE)) |

All three are pinned to exact versions in `package.json`. The build copies them (and their license files) into
`_site/vendor/`, and the `<script type="importmap">` in `index.html` points the browser at those copies.

To upgrade, run `npm install --save-exact luxon@<version>` (or `ical-generator@…`, `simple-calendar-js@…`), then
`npm test` and `npm run serve` to check, and commit `package.json` and `package-lock.json`. If a library moves its
files, the build stops with the missing path; update the list at the top of `scripts/build.mjs`.

SimpleCalendarJS's README describes some options its code doesn't have (`timezone`, `changeView()`, …). The
settings this site uses are in `renderCalendar()` in `site/assets/view.js`. Its list view is turned off because, as
of 3.0.14, it labels each day one day early in US time zones; try it again after upgrading.

| Path | Purpose |
| --- | --- |
| `schedule.json` | The schedule (source of truth) |
| `site/assets/core.js` | Shared logic: data model, validation, what the calendar shows, `.ics` generation |
| `site/index.html`, `site/assets/view.js`, `site/assets/style.css` | The public page |
| `scripts/build.mjs` | Builds `_site/` (page, libraries, `schedule.json`, `calendar.ics`, `competitions.ics`) |
| `.github/workflows/pages.yml` | Tests, builds, and deploys to Pages on push |
