// Shared schedule logic used by the public page, the editor, and the build script.
// No DOM access in this file, so it runs unchanged in the browser and in Node.
//
// Libraries (see package.json; the build copies them into the site for the browser):
//   Luxon          – dates, times and time zones   https://moment.github.io/luxon/
//   ical-generator – writes the .ics feeds          https://github.com/sebbo2002/ical-generator
import { DateTime, IANAZone, Interval } from 'luxon';
import ical, { ICalCalendarMethod, ICalEventStatus, ICalEventTransparency } from 'ical-generator';

export const STATUSES = ['meeting', 'tbd', 'off'];
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const DEFAULT_CALENDAR = {
  name: 'Hotwire Robotics',
  description: '',
  url: '',
  timezone: 'America/Los_Angeles',
  seasonStart: '',
  seasonEnd: '',
  meetingTitle: 'Robotics Meeting',
  meetingLocation: '',
  tbdTitle: 'Robotics Meeting (time TBD)',
  includeTbd: true,
};

/* ------------------------------------------------------------------ dates */
// Calendar dates are plain "YYYY-MM-DD" strings. They are read as UTC midnight so a date never
// shifts with the time zone of the computer running the code.

const calDate = (s) => DateTime.fromISO(s, { zone: 'utc', locale: 'en-US' });

export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && calDate(s).isValid;
export const addDays = (s, n) => calDate(s).plus({ days: n }).toISODate();
/** 0 = Sunday … 6 = Saturday (Luxon counts Monday = 1 … Sunday = 7). */
export const weekday = (s) => calDate(s).weekday % 7;
/** The Sunday on or before the date; the schedule's weeks run Sunday to Saturday. */
export const startOfWeek = (s) => addDays(s, -weekday(s));
export const daysBetween = (a, b) => calDate(b).diff(calDate(a), 'days').days;

/** Every date from start to end, inclusive. */
export function datesBetween(start, end) {
  if (end < start) return [];
  return Interval.fromDateTimes(calDate(start), calDate(end).plus({ days: 1 }))
    .splitBy({ days: 1 })
    .map((i) => i.start.toISODate());
}

const DATE_FORMATS = { short: 'LLL d', medium: 'ccc, LLL d', long: 'cccc, LLLL d, yyyy' };
/** 'short' → "Jan 10", 'medium' → "Sun, Jan 10", 'long' → "Sunday, January 10, 2027" */
export const formatDate = (s, style = 'short') => calDate(s).toFormat(DATE_FORMATS[style] || DATE_FORMATS.short);

/** "Mar 12 – 14", "Mar 29 – Apr 3", or "Feb 27" for single days. */
export function formatDateRange(start, end) {
  if (!end || end === start) return formatDate(start);
  if (calDate(start).hasSame(calDate(end), 'month')) return `${formatDate(start)} – ${calDate(end).day}`;
  return `${formatDate(start)} – ${formatDate(end)}`;
}

export const isTimeZone = (tz) => typeof tz === 'string' && IANAZone.isValidZone(tz);

/** Today's date ("YYYY-MM-DD") and minutes past midnight in the given time zone. */
export function nowIn(tz, now = new Date()) {
  const t = DateTime.fromJSDate(now, { zone: tz });
  return { date: t.toISODate(), minutes: t.hour * 60 + t.minute };
}

/** A wall-clock date + time ("18:00") in a time zone, e.g. a meeting start. */
const wallClock = (date, time, tz) => DateTime.fromISO(`${date}T${time}`, { zone: tz });

/** Converts a wall-clock date + time in `tz` to the matching instant. */
export const zonedToUtc = (date, time, tz) => wallClock(date, time, tz).toJSDate();

/* ------------------------------------------------------------------ times */
// Times are "HH:mm" strings on a 24-hour clock, e.g. "18:00".

const clock = (t) => DateTime.fromFormat(t, 'HH:mm', { zone: 'utc', locale: 'en-US' });

export const isTime = (t) => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
export const toMinutes = (t) => {
  const c = clock(t);
  return c.hour * 60 + c.minute;
};

const hours = (c) => c.toFormat(c.minute ? 'h:mm' : 'h'); // "6" or "6:30"
/** "6 PM", "6:30 PM" */
export const formatTime = (t) => `${hours(clock(t))} ${clock(t).toFormat('a')}`;
/** "6–9 PM", "11 AM–7 PM", "7 AM–9 PM" */
export function formatTimeRange(start, end) {
  const a = clock(start);
  const b = clock(end);
  if (a.toFormat('a') === b.toFormat('a')) return `${hours(a)}–${hours(b)} ${b.toFormat('a')}`;
  return `${formatTime(start)}–${formatTime(end)}`;
}

/* ------------------------------------------------------------------ schedule model */

const str = (v) => (v == null ? '' : String(v)).trim();

export function slugify(text) {
  return str(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

function normalizeDay(raw) {
  const day = { status: STATUSES.includes(raw?.status) ? raw.status : 'meeting' };
  if (day.status === 'meeting') {
    day.start = str(raw?.start);
    day.end = str(raw?.end);
  }
  for (const key of ['title', 'location', 'notes']) {
    const v = str(raw?.[key]);
    if (v) day[key] = v;
  }
  const tags = Array.isArray(raw?.tags) ? [...new Set(raw.tags.map(str).filter(Boolean))] : [];
  if (tags.length) day.tags = tags;
  return day;
}

function normalizeEvent(raw) {
  const ev = {
    id: str(raw?.id),
    title: str(raw?.title),
    start: str(raw?.start),
    end: str(raw?.end) || str(raw?.start),
    attending: raw?.attending !== false,
  };
  for (const key of ['location', 'notes']) {
    const v = str(raw?.[key]);
    if (v) ev[key] = v;
  }
  return ev;
}

/** Fills in defaults and drops empty optional fields. Always returns a fresh object. */
export function normalizeSchedule(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const calendar = { ...DEFAULT_CALENDAR };
  for (const key of Object.keys(DEFAULT_CALENDAR)) {
    const v = s.calendar?.[key];
    if (v === undefined || v === null) continue;
    calendar[key] = typeof DEFAULT_CALENDAR[key] === 'boolean' ? v !== false : str(v);
  }
  const days = {};
  for (const date of Object.keys(s.days || {}).sort()) days[date] = normalizeDay(s.days[date]);
  return {
    version: 1,
    calendar,
    tags: (Array.isArray(s.tags) ? s.tags : []).map((t) => ({
      id: str(t?.id) || slugify(t?.label),
      label: str(t?.label),
      color: /^#[0-9a-f]{6}$/i.test(str(t?.color)) ? str(t.color).toLowerCase() : '#cccccc',
    })),
    events: (Array.isArray(s.events) ? s.events : []).map(normalizeEvent),
    days,
  };
}

export const sortEvents = (events) =>
  [...events].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.title.localeCompare(b.title));

/** Returns a list of human-readable problems; empty when the schedule is valid. */
export function validateSchedule(s) {
  const errors = [];
  const cal = s.calendar || {};
  if (!str(cal.name)) errors.push('Calendar name is empty.');
  if (!isTimeZone(cal.timezone)) errors.push(`Time zone "${cal.timezone}" isn't recognized.`);
  if (cal.seasonStart && !isDate(cal.seasonStart)) errors.push('Season start date is invalid.');
  if (cal.seasonEnd && !isDate(cal.seasonEnd)) errors.push('Season end date is invalid.');
  if (isDate(cal.seasonStart) && isDate(cal.seasonEnd) && cal.seasonEnd < cal.seasonStart) errors.push('Season ends before it starts.');

  const tagIds = new Set();
  for (const t of s.tags || []) {
    if (!t.id) errors.push('A no-school color is missing its id.');
    else if (tagIds.has(t.id)) errors.push(`Two no-school colors share the id "${t.id}".`);
    tagIds.add(t.id);
    if (!t.label) errors.push(`No-school color "${t.id}" needs a label.`);
  }

  const eventIds = new Set();
  for (const ev of s.events || []) {
    const name = ev.title || ev.id || '(untitled event)';
    if (!ev.id) errors.push(`Event "${name}" is missing an id.`);
    else if (eventIds.has(ev.id)) errors.push(`Two events share the id "${ev.id}".`);
    eventIds.add(ev.id);
    if (!ev.title) errors.push(`An event (${ev.start || 'no date'}) needs a title.`);
    if (!isDate(ev.start)) errors.push(`Event "${name}" needs a valid start date.`);
    else if (!isDate(ev.end)) errors.push(`Event "${name}" needs a valid end date.`);
    else if (ev.end < ev.start) errors.push(`Event "${name}" ends before it starts.`);
  }

  for (const [date, day] of Object.entries(s.days || {})) {
    if (!isDate(date)) {
      errors.push(`"${date}" isn't a valid date.`);
      continue;
    }
    const label = formatDate(date, 'medium');
    if (!STATUSES.includes(day.status)) errors.push(`${label}: unknown status "${day.status}".`);
    if (day.status === 'meeting') {
      if (!isTime(day.start) || !isTime(day.end)) errors.push(`${label}: meeting needs a start and end time.`);
      else if (toMinutes(day.end) <= toMinutes(day.start)) errors.push(`${label}: meeting ends before it starts.`);
    }
    for (const tag of day.tags || []) {
      if (!tagIds.has(tag)) errors.push(`${label}: unknown no-school color "${tag}".`);
    }
  }
  return errors;
}

/**
 * Whether a date falls inside the season set in the calendar settings. Days outside the
 * season (kickoff, off-season events, …) are allowed; they're just shown a little differently.
 */
export function inSeason(s, date) {
  const { seasonStart, seasonEnd } = s.calendar;
  return (!isDate(seasonStart) || date >= seasonStart) && (!isDate(seasonEnd) || date <= seasonEnd);
}

/** First and last date the schedule grid should show: the season plus any days scheduled outside it. */
export function scheduleRange(s) {
  const dates = Object.keys(s.days).filter(isDate);
  const cal = s.calendar;
  const candidatesStart = [cal.seasonStart, dates[0]].filter(isDate).sort();
  const candidatesEnd = [cal.seasonEnd, dates[dates.length - 1]].filter(isDate).sort();
  if (!candidatesStart.length) return null;
  return { start: candidatesStart[0], end: candidatesEnd[candidatesEnd.length - 1] };
}

export const eventsCovering = (s, date) => s.events.filter((ev) => isDate(ev.start) && ev.start <= date && date <= ev.end);
export const attendingEventOn = (s, date) => sortEvents(eventsCovering(s, date)).find((ev) => ev.attending) || null;

/** Everything needed to show or export one day. */
export function describeDay(s, date) {
  const entry = s.days[date] || null;
  const attendingEvent = attendingEventOn(s, date);
  const cal = s.calendar;
  const tags = (entry?.tags || []).map((id) => s.tags.find((t) => t.id === id)).filter(Boolean);
  let title = '';
  let timeLabel = '';
  if (entry) {
    if (entry.status === 'meeting') {
      title = entry.title || attendingEvent?.title || cal.meetingTitle;
      timeLabel = isTime(entry.start) && isTime(entry.end) ? formatTimeRange(entry.start, entry.end) : 'Time?';
    } else if (entry.status === 'tbd') {
      title = entry.title || attendingEvent?.title || cal.tbdTitle;
      timeLabel = 'TBD';
    } else {
      title = entry.title || 'No meeting';
      timeLabel = 'Off';
    }
  }
  return {
    date,
    entry,
    status: entry?.status || null,
    title,
    timeLabel,
    tags,
    attendingEvent,
    inSeason: inSeason(s, date),
    location: entry?.location || attendingEvent?.location || (entry?.status === 'meeting' && !attendingEvent ? cal.meetingLocation : ''),
  };
}

/**
 * Rows of 7 days (Sunday–Saturday) covering the season and any days scheduled outside it, with
 * the events that start in each week. Empty weeks outside the season are left out (so one
 * off-season date in August doesn't add a dozen blank weeks); the next row's `skippedBefore`
 * says how many were left out.
 */
export function buildWeeks(s) {
  const range = scheduleRange(s);
  if (!range) return [];
  const weeks = [];
  const events = sortEvents(s.events).filter((ev) => isDate(ev.start));
  const { seasonStart, seasonEnd } = s.calendar;
  let skipped = 0;
  for (let start = startOfWeek(range.start); start <= range.end; start = addDays(start, 7)) {
    const end = addDays(start, 6);
    const dates = datesBetween(start, end);
    const first = weeks.length === 0 && skipped === 0;
    const weekEvents = events.filter((ev) => (ev.start >= start && ev.start <= end) || (first && ev.start < start && ev.end >= start));
    const touchesSeason = isDate(seasonStart) && isDate(seasonEnd) ? start <= seasonEnd && end >= seasonStart : true;
    if (!touchesSeason && !weekEvents.length && !dates.some((d) => s.days[d])) {
      skipped += 1;
      continue;
    }
    weeks.push({ start, end, dates, events: weekEvents, skippedBefore: skipped });
    skipped = 0;
  }
  return weeks;
}

/** The most common meeting time per weekday, used as defaults when turning a day into a meeting. */
export function typicalTimes(s) {
  const counts = Array.from({ length: 7 }, () => new Map());
  for (const [date, day] of Object.entries(s.days)) {
    if (day.status !== 'meeting' || !isTime(day.start) || !isTime(day.end) || !isDate(date)) continue;
    if (attendingEventOn(s, date)) continue; // competition hours aren't typical
    const key = `${day.start}-${day.end}`;
    const m = counts[weekday(date)];
    m.set(key, (m.get(key) || 0) + 1);
  }
  return counts.map((m) => {
    const best = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!best) return null;
    const [start, end] = best[0].split('-');
    return { start, end };
  });
}

/** Distinct meeting times, most used first. */
export function timePresets(s, limit = 6) {
  const m = new Map();
  for (const day of Object.values(s.days)) {
    if (day.status !== 'meeting' || !isTime(day.start) || !isTime(day.end)) continue;
    const key = `${day.start}-${day.end}`;
    m.set(key, (m.get(key) || 0) + 1);
  }
  if (!m.size) m.set('18:00-21:00', 1);
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key]) => {
      const [start, end] = key.split('-');
      return { start, end, label: formatTimeRange(start, end) };
    })
    .sort((a, b) => toMinutes(a.start) - toMinutes(b.start) || toMinutes(a.end) - toMinutes(b.end));
}

/* ------------------------------------------------------------------ JSON file format */

const DAY_KEYS = ['status', 'start', 'end', 'title', 'location', 'notes', 'tags'];
const EVENT_KEYS = ['id', 'title', 'start', 'end', 'attending', 'location', 'notes'];
const inline = (obj, keys) =>
  `{ ${keys.filter((k) => obj[k] !== undefined).map((k) => `${JSON.stringify(k)}: ${JSON.stringify(obj[k])}`).join(', ')} }`;

/**
 * Pretty-prints a schedule with one line per day and per event, so commits made by the
 * editor produce small, readable diffs.
 */
export function serializeSchedule(raw) {
  const s = normalizeSchedule(raw);
  const list = (items, keys) =>
    items.length ? `[\n${items.map((i) => `    ${inline(i, keys)}`).join(',\n')}\n  ]` : '[]';
  const days = Object.entries(s.days).map(([date, day]) => `    ${JSON.stringify(date)}: ${inline(day, DAY_KEYS)}`);
  return [
    '{',
    '  "version": 1,',
    `  "calendar": ${JSON.stringify(s.calendar, null, 2).replace(/\n/g, '\n  ')},`,
    `  "tags": ${list(s.tags, ['id', 'label', 'color'])},`,
    `  "events": ${list(sortEvents(s.events), EVENT_KEYS)},`,
    `  "days": ${days.length ? `{\n${days.join(',\n')}\n  }` : '{}'}`,
    '}',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ iCalendar (.ics) */

export const FEEDS = [
  { id: 'all', file: 'calendar.ics', label: 'Full schedule', blurb: 'Every meeting, TBD day, and competition.' },
  { id: 'competitions', file: 'competitions.ics', label: 'Competitions only', blurb: 'Just the events the team is attending.' },
];

/**
 * All-day entries from `start` through `end` (inclusive). In .ics files the end date is the day
 * *after* the last day, hence the +1.
 */
const allDay = (start, end = start) => ({ allDay: true, start: calDate(start), end: calDate(end).plus({ days: 1 }) });

/**
 * Builds an .ics feed.
 *   feed 'all'          – meetings (timed), TBD days (all-day, optional) and attended competitions
 *   feed 'competitions' – attended competitions plus the team hours on those days
 * UIDs are stable (based on the date or event id), so subscribed calendars update in place.
 */
export function buildIcs(raw, { feed = 'all', now = new Date() } = {}) {
  const s = normalizeSchedule(raw);
  const cal = s.calendar;
  const tz = isTimeZone(cal.timezone) ? cal.timezone : DEFAULT_CALENDAR.timezone;
  const feedInfo = FEEDS.find((f) => f.id === feed) || FEEDS[0];
  const uidSuffix = feedInfo.id === 'all' ? '' : `.${feedInfo.id}`;
  const url = /^https?:\/\/\S+$/.test(cal.url) ? cal.url : undefined;

  const calendar = ical({
    name: feedInfo.id === 'all' ? cal.name : `${cal.name} – ${feedInfo.label}`,
    description: cal.description || feedInfo.blurb,
    prodId: { company: 'Hotwire Robotics', product: 'web-cal' },
    method: ICalCalendarMethod.PUBLISH,
    ttl: 60 * 60, // ask calendar apps to check for changes every hour
  });
  calendar.x([{ key: 'X-WR-TIMEZONE', value: tz }]);

  const add = (key, event) => calendar.createEvent({ id: `${key}${uidSuffix}@web-cal.hotwirerobotics`, stamp: now, url, ...event });
  const description = (parts) => [...parts, cal.url && `Full schedule: ${cal.url}`].filter(Boolean).join('\n\n') || undefined;

  for (const ev of sortEvents(s.events)) {
    if (!ev.attending || !isDate(ev.start) || !isDate(ev.end)) continue;
    add(`event-${ev.id}`, {
      ...allDay(ev.start, ev.end),
      summary: ev.title,
      location: ev.location,
      description: description([ev.notes]),
      transparency: ICalEventTransparency.TRANSPARENT,
    });
  }

  for (const date of Object.keys(s.days)) {
    if (!isDate(date)) continue;
    const info = describeDay(s, date);
    const entry = info.entry;
    if (feedInfo.id === 'competitions' && !info.attendingEvent) continue;
    const details = [entry.notes, info.tags.map((t) => t.label).join(', ')];
    if (entry.status === 'meeting') {
      if (!isTime(entry.start) || !isTime(entry.end) || toMinutes(entry.end) <= toMinutes(entry.start)) continue;
      add(`day-${date}`, {
        start: wallClock(date, entry.start, tz),
        end: wallClock(date, entry.end, tz),
        summary: info.title,
        location: info.location || undefined,
        description: description(details),
        status: ICalEventStatus.CONFIRMED,
      });
    } else if (entry.status === 'tbd') {
      // A competition already covers this day as an all-day event.
      if (feedInfo.id !== 'all' || !cal.includeTbd || info.attendingEvent) continue;
      add(`day-${date}`, {
        ...allDay(date),
        summary: info.title,
        location: entry.location,
        description: description([...details, 'Meeting time has not been set yet. This entry updates automatically once it is.']),
        status: ICalEventStatus.TENTATIVE,
        transparency: ICalEventTransparency.TRANSPARENT,
      });
    }
  }

  return calendar.toString();
}
