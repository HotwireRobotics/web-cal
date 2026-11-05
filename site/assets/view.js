// Public schedule page.
import {
  FEEDS, daysBetween, describeDay, formatDate, formatDateRange, isDate, isTime, normalizeSchedule, nowIn, sortEvents, toMinutes,
} from './core.js';
import { escapeHtml, gridHtml, legendHtml } from './grid.js';

const $ = (sel) => document.querySelector(sel);

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('is-visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('is-visible'), 2200);
}

function relativeDays(n) {
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  return `in ${n} days`;
}

function renderNextUp(s, now) {
  const { date: today, minutes } = nowIn(s.calendar.timezone, now);
  const blocks = [];

  // Next day the team meets (or might meet, if the time is still TBD).
  const nextDay = Object.keys(s.days).sort().find((date) => {
    if (date < today) return false;
    const e = s.days[date];
    if (e.status === 'off') return false;
    if (date === today && e.status === 'meeting' && isTime(e.end) && toMinutes(e.end) <= minutes) return false;
    return true;
  });
  if (nextDay) {
    const info = describeDay(s, nextDay);
    const when = info.status === 'tbd' ? 'Time TBD' : info.timeLabel;
    const dayWord = nextDay === today ? 'Today' : formatDate(nextDay, 'long').replace(/, \d{4}$/, '');
    blocks.push(`<div class="next-block">
      <p class="eyebrow">Next meeting</p>
      <p class="next-big">${escapeHtml(dayWord)}</p>
      <p class="next-sub">${escapeHtml(when)} · ${escapeHtml(info.title)}${info.location ? ` · ${escapeHtml(info.location)}` : ''}</p>
    </div>`);
  } else {
    blocks.push(`<div class="next-block"><p class="eyebrow">Next meeting</p><p class="next-big">No upcoming meetings</p>
      <p class="next-sub">The season's schedule is complete.</p></div>`);
  }

  const comp = sortEvents(s.events).find((ev) => ev.attending && isDate(ev.start) && ev.end >= today);
  if (comp) {
    const ongoing = comp.start <= today;
    blocks.push(`<div class="next-block">
      <p class="eyebrow">${ongoing ? 'Competing now' : 'Next competition'}</p>
      <p class="next-big" style="font-size:18px">${escapeHtml(comp.title)}</p>
      <p class="next-sub">${escapeHtml(formatDateRange(comp.start, comp.end))}${comp.location ? ` · ${escapeHtml(comp.location)}` : ''}
        ${ongoing ? '' : `<span class="pill">${relativeDays(daysBetween(today, comp.start))}</span>`}</p>
    </div>`);
  }
  $('#next-up').innerHTML = blocks.join('');
}

function renderSubscribe(s) {
  const tabs = $('#feed-tabs');
  tabs.innerHTML = FEEDS.map(
    (f, i) => `<button type="button" role="tab" data-feed="${f.id}" aria-selected="${i === 0}">${escapeHtml(f.label)}</button>`,
  ).join('');

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

function renderGrid(s, today) {
  const grid = $('#grid');
  grid.innerHTML = gridHtml(s, { today });
  const cal = grid.querySelector('.cal');
  const past = grid.querySelectorAll('.week.is-past').length;
  if (cal && past) {
    cal.classList.add('hide-past');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm past-toggle';
    btn.textContent = `Show ${past} earlier week${past === 1 ? '' : 's'}`;
    btn.addEventListener('click', () => {
      const hidden = cal.classList.toggle('hide-past');
      btn.textContent = hidden ? `Show ${past} earlier week${past === 1 ? '' : 's'}` : 'Hide earlier weeks';
    });
    grid.prepend(btn);
  }
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
    $('#grid').innerHTML = '';
    return;
  }

  const cal = s.calendar;
  const now = new Date();
  const today = nowIn(cal.timezone, now).date;
  document.title = `${cal.name} Schedule`;
  $('#cal-name').textContent = cal.name;
  if (isDate(cal.seasonStart)) {
    $('#season').textContent = `${cal.seasonStart.slice(0, 4)} season · ${formatDateRange(cal.seasonStart, cal.seasonEnd || cal.seasonStart)}`;
  }

  renderNextUp(s, now);
  renderSubscribe(s);
  $('#legend').innerHTML = legendHtml(s);
  renderGrid(s, today);

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
