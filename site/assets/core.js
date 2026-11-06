// Shared schedule logic used by the public page and the build script.
// No DOM access in this file, so it runs unchanged in the browser and in Node.
//
// Libraries (see package.json; the build copies them into the site for the browser):
//   Luxon          – dates, times and time zones   https://moment.github.io/luxon/
//   ical-generator – writes the .ics feeds          https://github.com/sebbo2002/ical-generator
import { DateTime, IANAZone } from 'luxon';
import ical, { ICalCalendarMethod, ICalEventStatus, ICalEventTransparency } from 'ical-generator';

export const STATUSES = ['meeting', 'tbd', 'off'];

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
export const daysBetween = (a, b) => calDate(b).diff(calDate(a), 'days').days;

const DATE_FORMATS = { short: 'LLL d', medium: 'ccc, LLL d' };
/** 'short' → "Jan 10", 'medium' → "Sun, Jan 10" */
export const formatDate = (s, style = 'short') => calDate(s).toFormat(DATE_FORMATS[style] || DATE_FORMATS.short);

/** "Mar 12 – 14", "Mar 29 – Apr 3", or "Feb 27" for single days. */
export function formatDateRange(start, end) {
  if (!end || end === start) return formatDate(start);
  if (calDate(start).hasSame(calDate(end), 'month')) return `${formatDate(start)} – ${calDate(end).day}`;
  return `${formatDate(start)} – ${formatDate(end)}`;
}

export const isTimeZone = (tz) => typeof tz === 'string' && IANAZone.isValidZone(tz);

/** Today's date ("YYYY-MM-DD") in the given time zone. */
export const todayIn = (tz, now = new Date()) => DateTime.fromJSDate(now, { zone: tz }).toISODate();

/** A wall-clock date + time ("18:00") in a time zone, e.g. a meeting start. */
const wallClock = (date, time, tz) => DateTime.fromISO(`${date}T${time}`, { zone: tz });

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

function slugify(text) {
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

export const eventsCovering = (s, date) => s.events.filter((ev) => isDate(ev.start) && ev.start <= date && date <= ev.end);
export const attendingEventOn = (s, date) => sortEvents(eventsCovering(s, date)).find((ev) => ev.attending) || null;

/** Everything needed to show or export one day. */
export function describeDay(s, date) {
  const entry = s.days[date] || null;
  const attendingEvent = attendingEventOn(s, date);
  const cal = s.calendar;
  const tags = (entry?.tags || []).map((id) => s.tags.find((t) => t.id === id)).filter(Boolean);
  let title = '';
  if (entry?.status === 'meeting') title = entry.title || attendingEvent?.title || cal.meetingTitle;
  else if (entry?.status === 'tbd') title = entry.title || attendingEvent?.title || cal.tbdTitle;
  else if (entry) title = entry.title || 'No meeting';
  return {
    date,
    entry,
    status: entry?.status || null,
    title,
    tags,
    attendingEvent,
    location: entry?.location || attendingEvent?.location || (entry?.status === 'meeting' && !attendingEvent ? cal.meetingLocation : ''),
  };
}

/* ------------------------------------------------------------------ website calendar */

/**
 * Everything the website's calendar shows, as plain data (dates and times are the schedule's own
 * wall-clock values). `kind` is one of:
 *   'meeting'     – a timed meeting (start/end times set)
 *   'tbd'         – a meeting day without a time yet (left out on competition days, like the feed)
 *   'competition' – an event the team is attending
 *   'event'       – an event the team isn't attending (e.g. other weeks of the season)
 *   'tag'         – a no-school color, joined across back-to-back days ("No School All Three", Mar 22–26)
 * Days off are left out, the same as in the calendar feed.
 */
export function calendarEntries(s) {
  const entries = [];
  for (const ev of sortEvents(s.events)) {
    if (!isDate(ev.start) || !isDate(ev.end)) continue;
    entries.push({
      id: `event-${ev.id}`, kind: ev.attending ? 'competition' : 'event', title: ev.title,
      start: ev.start, end: ev.end, location: ev.location || '', notes: ev.notes || '',
    });
  }
  const tagRuns = new Map(); // tag id → its latest entry, so back-to-back days can be joined
  for (const date of Object.keys(s.days).filter(isDate)) {
    const info = describeDay(s, date);
    const { entry } = info;
    const day = { start: date, end: date, title: info.title, location: info.location || '', notes: entry.notes || '' };
    if (entry.status === 'meeting' && isTime(entry.start) && isTime(entry.end)) {
      entries.push({ ...day, id: date, kind: 'meeting', startTime: entry.start, endTime: entry.end });
    } else if (entry.status === 'tbd' && !info.attendingEvent) {
      entries.push({ ...day, id: date, kind: 'tbd' });
    }
    for (const tag of info.tags) {
      const run = tagRuns.get(tag.id);
      if (run && addDays(run.end, 1) === date) run.end = date;
      else {
        const next = { id: `${date}-${tag.id}`, kind: 'tag', title: tag.label, color: tag.color, start: date, end: date, location: '', notes: '' };
        tagRuns.set(tag.id, next);
        entries.push(next);
      }
    }
  }
  return entries;
}

/** First and last date the schedule covers (season dates, days and events), or null if it's empty. */
export function scheduleSpan(s) {
  const { seasonStart, seasonEnd } = s.calendar;
  const dates = [seasonStart, seasonEnd, ...Object.keys(s.days), ...s.events.flatMap((ev) => [ev.start, ev.end])].filter(isDate).sort();
  return dates.length ? { first: dates[0], last: dates.at(-1) } : null;
}

/** The date the website's calendar opens on: today, kept within the schedule's first and last dates. */
export function openingDate(s, today) {
  const span = scheduleSpan(s);
  if (!span || (today >= span.first && today <= span.last)) return today;
  return today < span.first ? span.first : span.last;
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
