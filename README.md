# Hotwire Robotics schedule (web-cal)

The team's 2027 meeting and competition schedule (Jan 10 – May 1, 2027), published on GitHub Pages as:

| What | Where |
| --- | --- |
| Schedule page with subscribe buttons | https://hotwirerobotics.github.io/web-cal/ |
| Full calendar feed (meetings, TBD days, competitions) | https://hotwirerobotics.github.io/web-cal/calendar.ics |
| Competitions-only feed | https://hotwirerobotics.github.io/web-cal/competitions.ics |
| Schedule editor | https://hotwirerobotics.github.io/web-cal/edit.html |

Everything comes from one file, [`schedule.json`](schedule.json). A GitHub Action turns it into the website and
the `.ics` feeds every time it changes, so subscribed calendars pick up edits on their next refresh.

## One-time setup

1. **Turn on Pages:** repository **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. **Run the deploy:** **Actions → Build and deploy calendar → Run workflow** (or push any commit).
   The first run before step 1 fails at the deploy step. That's expected; just run it again.
3. *(Optional)* Rename the default branch to `main` under **Settings → General → Default branch**.
   The workflow and editor follow whichever branch is the default, so nothing else needs changing.

## Updating the schedule (GUI)

Open **`edit.html`** on the site (also linked as "Edit schedule" at the bottom of the public page).

- **Days:** click a day, then set it to *Meeting* (with a time), *TBD*, *Off*, or *Blank*.
  Shift-click or drag to select a range, Ctrl/⌘-click to add days, or click a weekday name to select every one
  (handy for "all Thursdays are now 6–9 PM"). Switching TBD days to *Meeting* fills in each weekday's usual hours.
- **Days outside the season** (kickoff, summer demos, …): pick a date under *Add a day outside the season*. It's added
  as TBD and selected so you can set its time and title. These days appear on the site and in the calendar feeds like
  any other day.
- **No-school colors, title, location, notes** can be set per day. Notes show on the site and in the calendar entry.
- **Competitions & events:** add, rename, re-date, or delete them. *Attending* events get the red outline and are
  added to the calendar feeds. The rest (e.g. Week 3) only show on the website.
- **Calendar settings:** season dates, time zone, default meeting title and location, and whether TBD days appear
  in the feed.
- Undo/redo (Ctrl/⌘+Z) works throughout, and edits are kept in your browser until you publish.

### Publishing

Press **Publish**. The editor commits `schedule.json` to the repository, and the site and feeds rebuild in about a
minute. Publishing needs a GitHub token, entered once:

1. Go to [GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token](https://github.com/settings/personal-access-tokens/new).
2. **Resource owner:** HotwireRobotics. **Repository access:** *Only select repositories* → `web-cal`.
3. **Repository permissions → Contents:** *Read and write*. Set an expiration (the end of the season works).
4. Paste the token into the Publish dialog. Check *Remember the token on this device* only on your own computer.

If the organization requires approval for tokens, an org owner approves it under the org's
**Settings → Personal access tokens → Pending requests**.

**No token?** Use **More → Publish without a token**. It copies the schedule and opens GitHub's file editor. Select
everything there, paste, and click *Commit changes*. You can also download `schedule.json` and upload it on GitHub.

If someone else published since you opened the editor, you'll get a warning before overwriting their changes.

## Subscribing

The public page has one-click buttons for Apple Calendar (iPhone/Mac) and Google Calendar, plus a link to copy for
Outlook and other apps. Calendar apps re-check subscriptions on their own schedule: Apple and Outlook usually
within an hour or two, Google Calendar sometimes up to a day.

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

Times are 24-hour `HH:MM` in the calendar's time zone. Days can also have `title` and `location`.

Days don't have to fall between `seasonStart` and `seasonEnd`. Days outside the season are shown with dimmed dates,
and long empty stretches between them and the season are collapsed into one "N weeks with nothing scheduled" row.

The editor writes one line per day so commit diffs stay readable. Hand edits are fine too if they keep that layout
(`npm test` checks it). The build checks the file and fails with a clear message if something's wrong.

## Development

Plain HTML, CSS, and JavaScript with no bundler or framework. Requires Node 22+.

```bash
npm ci           # installs the libraries below, at the exact versions in package-lock.json
npm test         # validates schedule.json and the feed generator
npm run serve    # builds into _site/ and serves it at http://localhost:8080
```

### Libraries

| Library | Used for |
| --- | --- |
| [Luxon](https://moment.github.io/luxon/) | All date, time, and time zone handling (adding days, weekdays, formatting, local time → UTC across daylight saving) |
| [ical-generator](https://github.com/sebbo2002/ical-generator) | Writing the `.ics` feeds (escaping, line folding, all-day vs. timed events, refresh interval) |

Both are pinned to exact versions in `package.json`. Node loads them from `node_modules`, and the build copies the
same files into `_site/vendor/` for the browser (the `<script type="importmap">` in `index.html` and `edit.html`
points at those copies), so the website and the tests always run identical code.

To upgrade, run `npm install luxon@<version>` (or `ical-generator@<version>`), then `npm test` and `npm run serve`
to check, and commit `package.json` and `package-lock.json`.

| Path | Purpose |
| --- | --- |
| `schedule.json` | The schedule (source of truth) |
| `site/assets/core.js` | Shared logic: data model, validation, `.ics` generation (used by the browser and the build) |
| `site/assets/grid.js` | Week-by-week schedule grid |
| `site/index.html`, `site/assets/view.js` | Public page |
| `site/edit.html`, `site/assets/editor.js` | Editor |
| `scripts/build.mjs` | Builds `_site/` (pages, libraries, `schedule.json`, `calendar.ics`, `competitions.ics`) |
| `.github/workflows/pages.yml` | Tests, builds, and deploys to Pages on push |
