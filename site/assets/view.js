// Public schedule page: subscribe links and the calendar.
//
// The calendar is SimpleCalendarJS (https://www.simplecalendarjs.com). Its file doesn't export
// anything; loading it defines a global `SimpleCalendarJs`, which is what this import is for.
import 'simple-calendar-js';
import {
  FEEDS, calendarEntries, formatDateRange, formatTimeRange, isDate, normalizeSchedule, openingDate, todayIn,
} from './core.js';

const $ = (sel) => document.querySelector(sel);

// Colors on the calendar, from the team logo's flame (orange, yellow, red). No-school days use
// the colors set in schedule.json. Plain "#rrggbb" values, so SimpleCalendarJS can pick black or
// white text to go with each one.
const COLORS = { meeting: '#ff7927', tbd: '#ffcb05', competition: '#ed1c24', event: '#575757' };

function toast(message, ms = 2200) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('is-visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('is-visible'), ms);
}

function renderSubscribe() {
  const tabs = $('#feed-tabs');
  tabs.replaceChildren(
    ...FEEDS.map((feed) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.dataset.feed = feed.id;
      button.textContent = feed.label;
      return button;
    }),
  );

  const select = (id) => {
    const feed = FEEDS.find((f) => f.id === id) || FEEDS[0];
    const https = new URL(feed.file, window.location.href).href;
    const webcal = https.replace(/^https?:/, 'webcal:');
    $('#feed-url').value = https;
    $('#feed-blurb').textContent = feed.blurb;
    $('#sub-apple').href = webcal;
    $('#sub-google').href = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`;
    $('#sub-download').href = feed.file;
    $('#sub-download').setAttribute('download', feed.file);
    for (const b of tabs.querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.feed === feed.id));
  };
  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-feed]');
    if (b) select(b.dataset.feed);
  });
  select(FEEDS[0].id);

  $('#copy-feed').addEventListener('click', async () => {
    const input = $('#feed-url');
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      input.select();
      document.execCommand('copy');
    }
    toast('Calendar link copied');
  });
  $('#feed-url').addEventListener('focus', (e) => e.target.select());
}

/**
 * A Date for a schedule date + time ("18:00"). SimpleCalendarJS shows times in the viewer's own
 * time zone, so building the Date from the schedule's wall-clock values makes a 6 PM meeting read
 * "6 PM" for everyone, like the printed schedule. (The calendar feeds carry the real time zone.)
 */
function wallClock(date, time = '00:00') {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return new Date(year, month - 1, day, hour, minute);
}

/** One entry from calendarEntries() in the shape SimpleCalendarJS expects. */
function toCalendarEvent(entry) {
  const timed = entry.kind === 'meeting';
  const when = timed ? formatTimeRange(entry.startTime, entry.endTime) : formatDateRange(entry.start, entry.end);
  return {
    id: entry.id,
    title: entry.title,
    start: wallClock(entry.start, entry.startTime),
    end: wallClock(entry.end, entry.endTime),
    allDay: !timed,
    color: entry.color || COLORS[entry.kind],
    // Shown when hovering over the entry.
    tooltip: [entry.title, when, entry.kind === 'tbd' && 'Meeting time not set yet', entry.location, entry.notes].filter(Boolean).join('\n'),
  };
}

function renderCalendar(s, today) {
  const el = $('#calendar');
  el.replaceChildren();
  const events = calendarEntries(s).map(toCalendarEvent);
  // On narrow screens there's no room for "6 PM" next to each title, so meetings become bars.
  const narrow = window.matchMedia('(max-width: 640px)').matches;

  new window.SimpleCalendarJs(el, {
    defaultView: 'month',
    // Clicking a date (or "+N more") opens that day. No 'list' view: in SimpleCalendarJS 3.0.14 it
    // labels each day one day early in US time zones. Check again after upgrading.
    enabledViews: ['month', 'day'],
    defaultDate: wallClock(openingDate(s, today)),
    locale: 'en-US',
    monthTimedEventStyle: narrow ? 'block' : 'list',
    showBorder: false, // the card around it is the border
    autoContrastText: true,
    // Titles and notes are shown as plain text.
    allowHtmlInEvents: false,
    tooltipAllowHtml: false,
    fetchEvents: async () => events,
    // Hover shows the details on a computer; phones can't hover, so tapping shows them too.
    onEventClick: (event) => toast(event.tooltip, 6000),
  });
}

async function main() {
  let s;
  try {
    const res = await fetch('schedule.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    s = normalizeSchedule(await res.json());
  } catch (err) {
    const box = $('#load-error');
    box.hidden = false;
    box.textContent = `Couldn't load the schedule (${err.message}). Try refreshing the page.`;
    $('#calendar').replaceChildren();
    return;
  }

  const cal = s.calendar;
  document.title = `${cal.name} Schedule`;
  if (isDate(cal.seasonStart)) {
    const end = isDate(cal.seasonEnd) ? cal.seasonEnd : cal.seasonStart;
    $('#season-label').textContent = `${cal.seasonStart.slice(0, 4)} season`;
    $('#season-dates').textContent = `Meetings and competitions · ${formatDateRange(cal.seasonStart, end)}, ${end.slice(0, 4)}`;
  }

  renderSubscribe();
  renderCalendar(s, todayIn(cal.timezone));

  try {
    const info = await (await fetch('build-info.json', { cache: 'no-cache' })).json();
    const built = new Date(info.builtAt);
    if (!Number.isNaN(built.getTime())) {
      $('#updated').textContent = `Updated ${built.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    }
  } catch {
    /* build-info.json only exists on the published site */
  }
}

main();
