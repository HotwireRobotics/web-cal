// Shared schedule logic used by the public page, the editor, and the build script.
// No DOM access in this file, so it runs unchanged in the browser and in Node.

export const STATUSES = ['meeting', 'tbd', 'off'];
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));

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
// Dates are plain "YYYY-MM-DD" strings. Arithmetic happens in UTC so DST never shifts a day.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const toUtc = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const fromUtc = (d) => d.toISOString().slice(0, 10);

export function isDate(s) {
  return typeof s === 'string' && DATE_RE.test(s) && fromUtc(toUtc(s)) === s;
}
export function addDays(s, n) {
  const d = toUtc(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUtc(d);
}
export const weekday = (s) => toUtc(s).getUTCDay();
export const startOfWeek = (s) => addDays(s, -weekday(s));
export const daysBetween = (a, b) => Math.round((toUtc(b) - toUtc(a)) / 86400000);

export function datesBetween(start, end) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** 'short' → "Jan 10", 'medium' → "Sun, Jan 10", 'long' → "Sunday, January 10, 2027" */
export function formatDate(s, style = 'short') {
  const d = toUtc(s);
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const wd = d.getUTCDay();
  if (style === 'long') return `${WEEKDAYS[wd]}, ${MONTHS[m]} ${day}, ${d.getUTCFullYear()}`;
  if (style === 'medium') return `${WEEKDAYS_SHORT[wd]}, ${MONTHS_SHORT[m]} ${day}`;
  return `${MONTHS_SHORT[m]} ${day}`;
}

/** "Mar 12 – 14", "Mar 29 – Apr 3", or "Feb 27" for single days. */
export function formatDateRange(start, end) {
  if (!end || end === start) return formatDate(start);
  const a = toUtc(start);
  const b = toUtc(end);
  if (a.getUTCMonth() === b.getUTCMonth()) return `${formatDate(start)} – ${b.getUTCDate()}`;
  return `${formatDate(start)} – ${formatDate(end)}`;
}

const dtfCache = new Map();
function partsIn(tz, date) {
  let dtf = dtfCache.get(tz);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtfCache.set(tz, dtf);
  }
  const p = {};
  for (const { type, value } of dtf.formatToParts(date)) p[type] = value;
  return p;
}

export function isTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return typeof tz === 'string' && tz.length > 0;
  } catch {
    return false;
  }
}

/** Today's date ("YYYY-MM-DD") and minutes past midnight in the given time zone. */
export function nowIn(tz, now = new Date()) {
  const p = partsIn(tz, now);
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

function offsetMinutes(utcMs, tz) {
  const p = partsIn(tz, new Date(utcMs));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - utcMs) / 60000);
}

/** Converts a wall-clock date + time in `tz` to the matching UTC instant. */
export function zonedToUtc(date, time, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const first = offsetMinutes(guess, tz);
  let utc = guess - first * 60000;
  const second = offsetMinutes(utc, tz);
  if (second !== first) utc = guess - second * 60000;
  return new Date(utc);
}

/* ------------------------------------------------------------------ times */

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const isTime = (t) => typeof t === 'string' && TIME_RE.test(t);
export const toMinutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

function clock(t) {
  const h = Number(t.slice(0, 2));
  const m = t.slice(3, 5);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return { text: m === '00' ? String(h12) : `${h12}:${m}`, meridiem: h < 12 ? 'AM' : 'PM' };
}
export function formatTime(t) {
  const c = clock(t);
  return `${c.text} ${c.meridiem}`;
}
/** "6–9 PM", "11 AM–7 PM", "7 AM–9 PM" */
export function formatTimeRange(start, end) {
  const a = clock(start);
  const b = clock(end);
  if (a.meridiem === b.meridiem) return `${a.text}–${b.text} ${b.meridiem}`;
  return `${a.text} ${a.meridiem}–${b.text} ${b.meridiem}`;
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

/** First and last date the schedule grid should show. */
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
    location: entry?.location || attendingEvent?.location || (entry?.status === 'meeting' && !attendingEvent ? cal.meetingLocation : ''),
  };
}

/** Rows of 7 days (Sunday–Saturday) covering the season, with the events that start in each week. */
export function buildWeeks(s) {
  const range = scheduleRange(s);
  if (!range) return [];
  const weeks = [];
  const events = sortEvents(s.events).filter((ev) => isDate(ev.start));
  for (let start = startOfWeek(range.start); start <= range.end; start = addDays(start, 7)) {
    const end = addDays(start, 6);
    const first = weeks.length === 0;
    weeks.push({
      start,
      end,
      dates: datesBetween(start, end),
      events: events.filter((ev) => (ev.start >= start && ev.start <= end) || (first && ev.start < start && ev.end >= start)),
    });
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

const icsText = (v) => String(v).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsDate = (d) => d.replace(/-/g, '');
const icsUtc = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

const encoder = new TextEncoder();
/** Folds lines longer than 75 octets (RFC 5545 §3.1) without splitting UTF-8 characters. */
function fold(line) {
  if (encoder.encode(line).length <= 75) return line;
  const parts = [];
  let current = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (bytes + size > limit) {
      parts.push(current);
      current = '';
      bytes = 0;
      limit = 74; // continuation lines start with a space
    }
    current += ch;
    bytes += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

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
  const stamp = icsUtc(now);
  const feedInfo = FEEDS.find((f) => f.id === feed) || FEEDS[0];
  const calName = feedInfo.id === 'all' ? cal.name : `${cal.name} – ${feedInfo.label}`;
  const uidSuffix = feedInfo.id === 'all' ? '' : `.${feedInfo.id}`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Hotwire Robotics//web-cal//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(calName)}`,
    `X-WR-TIMEZONE:${tz}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  const desc = cal.description || feedInfo.blurb;
  if (desc) lines.push(`X-WR-CALDESC:${icsText(desc)}`);

  const add = (props) => lines.push('BEGIN:VEVENT', ...props.filter(Boolean), 'END:VEVENT');
  const uid = (key) => `UID:${key}${uidSuffix}@web-cal.hotwirerobotics`;
  const description = (parts) => {
    const text = [...parts.filter(Boolean), cal.url /*&& `Full schedule: ${cal.url}`*/].filter(Boolean).join('\n\n');
    return text ? `DESCRIPTION:${icsText(text)}` : null;
  };
  const url = /^https?:\/\/\S+$/.test(cal.url) ? `URL:${cal.url}` : null;

  for (const ev of sortEvents(s.events)) {
    if (!ev.attending || !isDate(ev.start) || !isDate(ev.end)) continue;
    add([
      uid(`event-${ev.id}`),
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(ev.start)}`,
      `DTEND;VALUE=DATE:${icsDate(addDays(ev.end, 1))}`,
      `SUMMARY:${icsText(ev.title)}`,
      ev.location && `LOCATION:${icsText(ev.location)}`,
      description([ev.notes]),
      'TRANSP:TRANSPARENT',
      url,
    ]);
  }

  for (const date of Object.keys(s.days)) {
    if (!isDate(date)) continue;
    const info = describeDay(s, date);
    const entry = info.entry;
    if (feedInfo.id === 'competitions' && !info.attendingEvent) continue;
    const details = [
      entry.notes,
      info.tags.length ? info.tags.map((t) => t.label).join(', ') : '',
    ];
    if (entry.status === 'meeting') {
      if (!isTime(entry.start) || !isTime(entry.end) || toMinutes(entry.end) <= toMinutes(entry.start)) continue;
      add([
        uid(`day-${date}`),
        `DTSTAMP:${stamp}`,
        `DTSTART:${icsUtc(zonedToUtc(date, entry.start, tz))}`,
        `DTEND:${icsUtc(zonedToUtc(date, entry.end, tz))}`,
        `SUMMARY:${icsText(info.title)}`,
        info.location && `LOCATION:${icsText(info.location)}`,
        description(details),
        'STATUS:CONFIRMED',
        url,
      ]);
    } else if (entry.status === 'tbd') {
      // A competition already covers this day as an all-day event.
      if (feedInfo.id !== 'all' || !cal.includeTbd || info.attendingEvent) continue;
      add([
        uid(`day-${date}`),
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${icsDate(date)}`,
        `DTEND;VALUE=DATE:${icsDate(addDays(date, 1))}`,
        `SUMMARY:${icsText(info.title)}`,
        entry.location && `LOCATION:${icsText(entry.location)}`,
        description([...details, 'Meeting time has not been set yet. This entry updates automatically once it is.']),
        'STATUS:TENTATIVE',
        'TRANSP:TRANSPARENT',
        url,
      ]);
    }
  }

  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
