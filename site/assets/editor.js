// Schedule editor: edit days, events, colors and settings, then publish schedule.json to GitHub.
import {
  DEFAULT_CALENDAR, buildIcs, describeDay, formatDate, formatDateRange, formatTimeRange, isDate,
  isTime, isTimeZone, normalizeSchedule, nowIn, serializeSchedule, slugify, sortEvents,
  timePresets, toMinutes, typicalTimes, validateSchedule, weekday,
} from './core.js';
import { escapeHtml, gridHtml, legendHtml } from './grid.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const KEYS = {
  draft: 'webcal:draft',
  conn: 'webcal:github',
  token: 'webcal:token',
  lastPublished: 'webcal:last-published',
};
const FALLBACK_REPO = 'HotwireRobotics/web-cal';

// localStorage can throw (private mode, blocked storage); the editor still works without it.
const store = {
  get(area, key) {
    try { return JSON.parse(area.getItem(key)); } catch { return null; }
  },
  set(area, key, value) {
    try { area.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  },
  remove(area, key) {
    try { area.removeItem(key); } catch { /* ignore */ }
  },
};

const state = {
  schedule: normalizeSchedule({}),
  baseNorm: '', // serialized form of what is on GitHub
  baseSha: null, // git blob sha of schedule.json on GitHub (when known)
  selected: new Set(),
  anchor: null,
  undo: [],
  redo: [],
  lastCoalesce: null,
  lastChangeAt: 0,
  errors: [],
  loaded: false,
};

/* ================================================================ helpers */

function toast(message, ms = 2600) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('is-visible');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('is-visible'), ms);
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

const tz = () => (isTimeZone(state.schedule.calendar.timezone) ? state.schedule.calendar.timezone : DEFAULT_CALENDAR.timezone);
const today = () => nowIn(tz()).date;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function addMinutes(time, minutes) {
  const total = Math.min(toMinutes(time) + minutes, 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function base64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** Same id git (and the GitHub API) uses for a file's contents. */
async function gitBlobSha(text) {
  if (!globalThis.crypto?.subtle) return null;
  const body = new TextEncoder().encode(text);
  const head = new TextEncoder().encode(`blob ${body.length}\0`);
  const buf = new Uint8Array(head.length + body.length);
  buf.set(head);
  buf.set(body, head.length);
  const hash = await crypto.subtle.digest('SHA-1', buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeNormalizeText(text) {
  try {
    return serializeSchedule(JSON.parse(text));
  } catch {
    return null;
  }
}

/* ================================================================ GitHub */

function defaultRepo() {
  const host = window.location.hostname;
  if (host.endsWith('.github.io')) {
    const owner = host.slice(0, -'.github.io'.length);
    const first = window.location.pathname.split('/').filter(Boolean)[0];
    return `${owner}/${first && !first.includes('.') ? first : `${owner}.github.io`}`;
  }
  return FALLBACK_REPO;
}

function getConn() {
  const saved = store.get(localStorage, KEYS.conn) || {};
  return {
    repo: saved.repo || defaultRepo(),
    branch: saved.branch || '',
    path: saved.path || 'schedule.json',
  };
}
function saveConn(conn) {
  store.set(localStorage, KEYS.conn, conn);
  renderRepoLabel();
}
const getToken = () => store.get(sessionStorage, KEYS.token) || store.get(localStorage, KEYS.token) || '';
function saveToken(token, remember) {
  store.remove(sessionStorage, KEYS.token);
  store.remove(localStorage, KEYS.token);
  if (token) store.set(remember ? localStorage : sessionStorage, KEYS.token, token);
}

class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function gh(path, { token = getToken(), method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`https://api.github.com${path}`, {
      method,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new GitHubError("Couldn't reach GitHub. Check your internet connection.", 0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new GitHubError(data?.message || `GitHub returned ${res.status}`, res.status);
  return data;
}

const contentsPath = (conn) => `/repos/${conn.repo}/contents/${conn.path.split('/').map(encodeURIComponent).join('/')}`;

async function fetchRemote(conn = getConn()) {
  const ref = conn.branch ? `?ref=${encodeURIComponent(conn.branch)}` : '';
  const data = await gh(`${contentsPath(conn)}${ref}`);
  if (data?.encoding !== 'base64' || typeof data.content !== 'string') throw new GitHubError('Unexpected response from GitHub.', 0);
  return { text: base64ToUtf8(data.content), sha: data.sha };
}

function explainGitHubError(err, conn) {
  switch (err.status) {
    case 401:
      return 'GitHub rejected the access token. It may be mistyped or expired.';
    case 403:
      return /rate limit/i.test(err.message)
        ? 'GitHub rate limit reached. Add an access token or try again later.'
        : `This token can't write to ${conn.repo}. Give it “Contents: Read and write” access to that repository.`;
    case 404:
      return `Couldn't find ${conn.repo} (or the token can't see it). Check the repository name and the token's repository access.`;
    case 409:
      return 'The file changed on GitHub while publishing. Try again.';
    default:
      return err.message || 'Something went wrong talking to GitHub.';
  }
}

/* ================================================================ state changes */

function change(mutate, { coalesce = null, parts = ['grid', 'panel'] } = {}) {
  const now = Date.now();
  const before = JSON.stringify(state.schedule);
  const merge = coalesce && coalesce === state.lastCoalesce && now - state.lastChangeAt < 2000;
  mutate(state.schedule);
  state.lastCoalesce = coalesce;
  state.lastChangeAt = now;
  if (JSON.stringify(state.schedule) === before) return;
  if (!merge) {
    state.undo.push(before);
    if (state.undo.length > 300) state.undo.shift();
  }
  state.redo = [];
  render(parts);
  afterChange();
}

function replaceSchedule(next, parts = ['all']) {
  change((s) => {
    for (const key of Object.keys(s)) delete s[key];
    Object.assign(s, normalizeSchedule(next));
  }, { parts });
}

function undo() {
  if (!state.undo.length) return;
  state.redo.push(JSON.stringify(state.schedule));
  state.schedule = JSON.parse(state.undo.pop());
  state.lastCoalesce = null;
  render(['all']);
  afterChange();
}
function redo() {
  if (!state.redo.length) return;
  state.undo.push(JSON.stringify(state.schedule));
  state.schedule = JSON.parse(state.redo.pop());
  state.lastCoalesce = null;
  render(['all']);
  afterChange();
}

const isDirty = () => serializeSchedule(state.schedule) !== state.baseNorm;

function afterChange() {
  state.errors = validateSchedule(state.schedule);
  renderStatus();
  saveDraft();
}

function saveDraft() {
  if (!state.loaded) return;
  if (isDirty()) store.set(localStorage, KEYS.draft, { text: serializeSchedule(state.schedule), baseSha: state.baseSha, savedAt: Date.now() });
  else store.remove(localStorage, KEYS.draft);
}

function setBase(text, sha) {
  state.baseNorm = safeNormalizeText(text) ?? '';
  state.baseSha = sha;
}

/* ================================================================ rendering */

function render(parts) {
  const all = parts.includes('all');
  if (all || parts.includes('grid')) renderGrid();
  if (all || parts.includes('panel')) renderPanel();
  if (all || parts.includes('events')) renderEvents();
  if (all || parts.includes('tags')) renderTags();
  if (all || parts.includes('settings')) renderSettings();
}

function renderStatus() {
  const el = $('#save-state');
  const dirty = isDirty();
  const n = state.errors.length;
  el.className = `save-state ${n ? 'is-error' : dirty ? 'is-dirty' : 'is-clean'}`;
  el.textContent = n ? `${plural(n, 'problem')} to fix` : dirty ? 'Unpublished changes' : 'Up to date';
  $('#publish-btn').disabled = !state.loaded || !dirty || n > 0;
  $('#publish-btn').title = n ? 'Fix the problems listed in the side panel first' : 'Publish (Ctrl/⌘+S)';
  $('#undo-btn').disabled = !state.undo.length;
  $('#redo-btn').disabled = !state.redo.length;
  const box = $('#problems');
  box.hidden = n === 0;
  box.innerHTML = n
    ? `<b>${plural(n, 'problem')} to fix before publishing</b>
       <ul>${state.errors.slice(0, 12).map((e) => `<li>${escapeHtml(e)}</li>`).join('')}${n > 12 ? `<li>…and ${n - 12} more</li>` : ''}</ul>`
    : '';
}

function renderRepoLabel() {
  const conn = getConn();
  $('#repo-label').textContent = `${conn.repo}${conn.branch ? ` @ ${conn.branch}` : ''} · ${conn.path}`;
}

function withFocusKept(container, fn) {
  const active = document.activeElement;
  const key = container.contains(active)
    ? { id: active.closest('[data-id]')?.dataset.id, field: active.dataset.field || active.dataset.setting || active.dataset.date }
    : null;
  fn();
  if (!key) return;
  const row = key.id ? $$('[data-id]', container).find((r) => r.dataset.id === key.id) : container;
  const target = row && $$('[data-field],[data-setting],[data-date]', row).find(
    (el) => (el.dataset.field || el.dataset.setting || el.dataset.date) === key.field,
  );
  target?.focus({ preventScroll: true });
}

function renderGrid() {
  const grid = $('#grid');
  withFocusKept(grid, () => {
    grid.innerHTML = gridHtml(state.schedule, { today: today(), selected: state.selected, editable: true });
  });
  $('#legend').innerHTML = legendHtml(state.schedule);
  // Drop selected days that are no longer on the grid (e.g. after shortening the season).
  const visible = new Set($$('.day', grid).map((el) => el.dataset.date));
  for (const d of state.selected) if (!visible.has(d)) state.selected.delete(d);
}

function paintSelection() {
  for (const el of $$('#grid .day')) {
    const on = state.selected.has(el.dataset.date);
    el.classList.toggle('is-selected', on);
    el.setAttribute('aria-pressed', String(on));
  }
}

function setSelection(dates, { anchor } = {}) {
  state.selected = new Set(dates);
  if (anchor !== undefined) state.anchor = anchor;
  state.lastCoalesce = null;
  paintSelection();
  renderPanel();
}

/* ---------------------------------------------------------------- side panel */

function selectedDates() {
  return [...state.selected].sort();
}

const common = (values) => {
  const set = new Set(values);
  return set.size === 1 ? [...set][0] : null;
};

function idlePanelHtml() {
  const s = state.schedule;
  const days = Object.values(s.days);
  const count = (st) => days.filter((d) => d.status === st).length;
  return `
    <div class="panel-head"><div>
      <h2>Select days to edit</h2>
      <p class="hint">Click a day on the schedule, or drag across several.</p>
    </div></div>
    <div class="stats">
      <div class="stat"><b>${count('meeting')}</b><span>meetings</span></div>
      <div class="stat"><b>${count('tbd')}</b><span>TBD days</span></div>
      <div class="stat"><b>${s.events.filter((e) => e.attending).length}</b><span>competitions</span></div>
    </div>
    <p class="hint idle-extra">Edits are kept in this browser as you go. Press <b>Publish</b> to update the website and everyone's subscribed calendars.</p>`;
}

function previewHtml(dates) {
  const s = state.schedule;
  if (dates.length > 1) {
    const counts = { meeting: 0, tbd: 0, off: 0, blank: 0 };
    for (const d of dates) counts[s.days[d]?.status || 'blank'] += 1;
    const parts = [
      counts.meeting && plural(counts.meeting, 'meeting'),
      counts.tbd && `${counts.tbd} TBD`,
      counts.off && `${counts.off} off`,
      counts.blank && `${counts.blank} blank`,
    ].filter(Boolean);
    return `<p class="preview-line">${escapeHtml(parts.join(' · '))}</p>`;
  }
  const info = describeDay(s, dates[0]);
  let text;
  if (!info.status) text = 'Not on the schedule.';
  else if (info.status === 'off') text = 'No meeting. Not added to the calendar.';
  else if (info.status === 'meeting') {
    text = `Calendar entry: <strong>${escapeHtml(info.title)}</strong>, ${escapeHtml(info.timeLabel)}${info.location ? ` at ${escapeHtml(info.location)}` : ''}.`;
  } else if (info.attendingEvent) {
    text = `Covered by the all-day <strong>${escapeHtml(info.attendingEvent.title)}</strong> calendar entry.`;
  } else if (s.calendar.includeTbd) {
    text = `Calendar entry: all-day <strong>${escapeHtml(info.title)}</strong> until a time is set.`;
  } else {
    text = 'Not added to the calendar (TBD days are turned off in settings).';
  }
  return `<p class="preview-line">${text}</p>`;
}

function renderPanel() {
  const panel = $('#panel');
  const s = state.schedule;
  const dates = selectedDates();
  panel.classList.toggle('is-idle', dates.length === 0);
  if (!dates.length) {
    panel.innerHTML = idlePanelHtml();
    return;
  }

  const entries = dates.map((d) => s.days[d] || null);
  const filled = entries.filter(Boolean);
  const status = common(entries.map((e) => e?.status || 'blank'));
  const meetings = filled.filter((e) => e.status === 'meeting');
  const start = common(meetings.map((e) => e.start));
  const end = common(meetings.map((e) => e.end));
  const timesMixed = meetings.length > 0 && (!start || !end);
  const allMeetings = meetings.length === dates.length;

  let heading;
  let sub;
  if (dates.length === 1) {
    heading = formatDate(dates[0], 'long').replace(/, \d{4}$/, '');
    const ev = describeDay(s, dates[0]).attendingEvent;
    sub = ev ? ev.title : '';
  } else {
    heading = `${dates.length} days selected`;
    sub = formatDateRange(dates[0], dates[dates.length - 1]);
  }

  const statusBtn = (value, label, title = '') =>
    `<button type="button" data-status="${value}" aria-pressed="${status === value}"${title ? ` title="${title}"` : ''}>${label}</button>`;
  const presets = timePresets(s)
    .map((p) => {
      const on = allMeetings && meetings.every((e) => e.start === p.start && e.end === p.end);
      return `<button type="button" class="chip" data-start="${p.start}" data-end="${p.end}" aria-pressed="${on}">${escapeHtml(p.label)}</button>`;
    })
    .join('');
  const noFilled = filled.length === 0;
  const tagChecks = s.tags.length
    ? s.tags.map((t) => {
      const n = filled.filter((e) => e.tags?.includes(t.id)).length;
      return `<label class="check"><input type="checkbox" data-tag="${escapeHtml(t.id)}" ${n && n === filled.length ? 'checked' : ''}
          ${n && n < filled.length ? 'data-mixed="1"' : ''} ${noFilled ? 'disabled' : ''}>
          <span class="swatch" style="background:${escapeHtml(t.color)}"></span>${escapeHtml(t.label)}</label>`;
    }).join('')
    : '<p class="hint">No colors defined yet.</p>';

  const textField = (field, label, multiline = false) => {
    const values = filled.map((e) => e[field] || '');
    const value = common(values);
    let placeholder = 'Optional';
    if (value === null) placeholder = 'Mixed — typing replaces all';
    else if (dates.length === 1 && field === 'title') placeholder = describeDay(s, dates[0]).title || 'Optional';
    else if (dates.length === 1 && field === 'location') placeholder = describeDay(s, dates[0]).location || 'Optional';
    const attrs = `id="f-${field}" data-text="${field}" placeholder="${escapeHtml(placeholder)}" ${noFilled ? 'disabled' : ''}`;
    const input = multiline
      ? `<textarea ${attrs}>${escapeHtml(value ?? '')}</textarea>`
      : `<input type="text" ${attrs} value="${escapeHtml(value ?? '')}">`;
    return `<div class="field"><label class="field-label" for="f-${field}">${label}</label>${input}</div>`;
  };

  panel.innerHTML = `
    <div class="panel-head">
      <div><h2>${escapeHtml(heading)}</h2>${sub ? `<p class="hint">${escapeHtml(sub)}</p>` : ''}</div>
      <button type="button" class="btn btn-sm btn-ghost" data-action="deselect" title="Clear selection (Esc)">Done</button>
    </div>
    <div class="field">
      <span class="field-label">Status ${status === null ? '<span class="mixed">mixed</span>' : ''}</span>
      <div class="seg">
        ${statusBtn('meeting', 'Meeting')}${statusBtn('tbd', 'TBD')}${statusBtn('off', 'Off')}${statusBtn('blank', 'Blank', 'Remove from the schedule')}
      </div>
    </div>
    <div class="field">
      <span class="field-label">Time ${timesMixed ? '<span class="mixed">mixed</span>' : ''}</span>
      <div class="time-row">
        <input type="time" id="f-start" value="${allMeetings || meetings.length ? escapeHtml(start || '') : ''}" step="900" aria-label="Start time">
        <span class="muted">to</span>
        <input type="time" id="f-end" value="${allMeetings || meetings.length ? escapeHtml(end || '') : ''}" step="900" aria-label="End time">
      </div>
      <div class="presets">${presets}</div>
      ${allMeetings ? '' : '<p class="hint">Picking a time makes the selected days meetings.</p>'}
    </div>
    <div class="field">
      <span class="field-label">No school</span>
      <div class="tag-checks">${tagChecks}</div>
      ${noFilled ? '<p class="hint">Set a status first.</p>' : ''}
    </div>
    ${textField('title', 'Title')}
    ${textField('location', 'Location')}
    ${textField('notes', 'Notes', true)}
    ${previewHtml(dates)}`;

  for (const box of $$('input[data-mixed]', panel)) box.indeterminate = true;
}

/** Refreshes the parts of the panel that depend on data, without replacing the input being typed in. */
function refreshPanelPreview() {
  const dates = selectedDates();
  const old = $('#panel .preview-line');
  if (old && dates.length) old.outerHTML = previewHtml(dates);
  const s = state.schedule;
  const status = common(dates.map((d) => s.days[d]?.status || 'blank'));
  for (const btn of $$('#panel [data-status]')) btn.setAttribute('aria-pressed', String(btn.dataset.status === status));
  const meetings = dates.map((d) => s.days[d]).filter((e) => e?.status === 'meeting');
  for (const chip of $$('#panel .chip')) {
    const on = meetings.length === dates.length && meetings.every((e) => e.start === chip.dataset.start && e.end === chip.dataset.end);
    chip.setAttribute('aria-pressed', String(on));
  }
}

/* ---------------------------------------------------------------- applying panel edits */

function applyStatus(status) {
  const dates = selectedDates();
  const typical = typicalTimes(state.schedule);
  const fallback = { start: $('#f-start')?.value || '18:00', end: $('#f-end')?.value || '21:00' };
  change((s) => {
    for (const d of dates) {
      const cur = s.days[d];
      if (status === 'blank') {
        delete s.days[d];
        continue;
      }
      const next = { ...(cur || {}), status };
      if (status === 'meeting') {
        if (!(cur?.status === 'meeting' && isTime(cur.start) && isTime(cur.end))) {
          const t = typical[weekday(d)] || (isTime(fallback.start) && isTime(fallback.end) ? fallback : { start: '18:00', end: '21:00' });
          next.start = t.start;
          next.end = t.end;
        }
      } else {
        delete next.start;
        delete next.end;
      }
      s.days[d] = next;
    }
  });
}

function applyTimes({ start, end }) {
  const dates = selectedDates();
  const typical = typicalTimes(state.schedule);
  change((s) => {
    for (const d of dates) {
      const cur = s.days[d] || {};
      const next = { ...cur, status: 'meeting' };
      const t = typical[weekday(d)];
      if (start) next.start = start;
      if (end) next.end = end;
      if (!isTime(next.start)) next.start = t?.start || (isTime(next.end) ? addMinutes(next.end, -180) : '18:00');
      if (!isTime(next.end)) next.end = t && toMinutes(t.end) > toMinutes(next.start) ? t.end : addMinutes(next.start, 180);
      s.days[d] = next;
    }
  }, { parts: ['grid'] });
}

function applyTag(id, on) {
  const dates = selectedDates();
  change((s) => {
    for (const d of dates) {
      const day = s.days[d];
      if (!day) continue;
      const tags = new Set(day.tags || []);
      if (on) tags.add(id);
      else tags.delete(id);
      if (tags.size) day.tags = s.tags.map((t) => t.id).filter((t) => tags.has(t));
      else delete day.tags;
    }
  });
}

function applyText(field, value) {
  const dates = selectedDates();
  const v = value.trim();
  change((s) => {
    for (const d of dates) {
      const day = s.days[d];
      if (!day) continue;
      if (v) day[field] = v;
      else delete day[field];
    }
  }, { coalesce: `text:${field}:${dates.join(',')}`, parts: ['grid'] });
}

/* ---------------------------------------------------------------- events list */

function renderEvents() {
  const list = $('#events');
  const events = sortEvents(state.schedule.events);
  withFocusKept(list, () => {
    list.innerHTML = events.length
      ? events.map((ev) => `
        <div class="ev-row ${ev.attending ? '' : 'is-other'}" data-id="${escapeHtml(ev.id)}">
          <label class="check" title="The team is going to this event"><input type="checkbox" data-field="attending" ${ev.attending ? 'checked' : ''}> Attending</label>
          <input class="ev-title" type="text" data-field="title" value="${escapeHtml(ev.title)}" placeholder="Event name" aria-label="Event name">
          <input type="date" data-field="start" value="${escapeHtml(ev.start)}" aria-label="Start date" required>
          <input type="date" data-field="end" value="${escapeHtml(ev.end)}" aria-label="End date" required>
          <input class="ev-loc" type="text" data-field="location" value="${escapeHtml(ev.location || '')}" placeholder="Location (optional)" aria-label="Location">
          <input class="ev-notes" type="text" data-field="notes" value="${escapeHtml(ev.notes || '')}" placeholder="Notes (optional)" aria-label="Notes">
          <div class="row-actions">
            <button type="button" class="btn btn-sm btn-ghost" data-action="select-event">Select days</button>
            <button type="button" class="btn btn-sm btn-ghost btn-danger" data-action="delete-event">Delete</button>
          </div>
        </div>`).join('')
      : '<p class="hint">No events yet.</p>';
  });
}

function findEvent(id) {
  return state.schedule.events.find((e) => e.id === id);
}

function selectEventDays(id) {
  const ev = findEvent(id);
  if (!ev || !isDate(ev.start) || !isDate(ev.end)) return;
  const dates = visibleDates().filter((d) => d >= ev.start && d <= ev.end);
  if (!dates.length) return toast("None of that event's days are on the schedule yet");
  setSelection(dates, { anchor: dates[0] });
  $(`#grid .day[data-date="${dates[0]}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** Adds a day anywhere on the calendar, even outside the season, and selects it for editing. */
function addDay(date) {
  if (!isDate(date)) return toast('Pick a date first');
  if (state.schedule.days[date]) {
    toast(`${formatDate(date, 'medium')} is already on the schedule`);
  } else {
    change((s) => {
      s.days[date] = { status: 'tbd' };
    }, { parts: ['grid'] });
    toast(`Added ${formatDate(date, 'medium')} as TBD. Set its status, time and title in the edit panel.`, 4000);
  }
  setSelection([date], { anchor: date });
  $(`#grid .day[data-date="${date}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function uniqueId(base, taken) {
  let id = base;
  for (let i = 2; taken.has(id); i += 1) id = `${base}-${i}`;
  return id;
}

function addEvent() {
  const s = state.schedule;
  const dates = selectedDates();
  const start = dates[0] || s.calendar.seasonStart || today();
  const end = dates[dates.length - 1] || start;
  const id = uniqueId(`event-${Date.now().toString(36)}`, new Set(s.events.map((e) => e.id)));
  change((sch) => {
    sch.events.push({ id, title: 'New event', start, end, attending: true });
  }, { parts: ['grid', 'events', 'panel'] });
  const input = $(`#events [data-id="${id}"] [data-field="title"]`);
  input?.focus();
  input?.select();
}

/* ---------------------------------------------------------------- tags */

function renderTags() {
  const list = $('#tags');
  const s = state.schedule;
  withFocusKept(list, () => {
    list.innerHTML = s.tags.length
      ? s.tags.map((t) => {
        const used = Object.values(s.days).filter((d) => d.tags?.includes(t.id)).length;
        return `<div class="tag-row" data-id="${escapeHtml(t.id)}">
          <input type="color" data-field="color" value="${escapeHtml(t.color)}" aria-label="Color for ${escapeHtml(t.label)}">
          <input type="text" data-field="label" value="${escapeHtml(t.label)}" aria-label="Label">
          <span class="hint" style="white-space:nowrap">${plural(used, 'day')}</span>
          <button type="button" class="btn btn-sm btn-ghost btn-danger" data-action="delete-tag">Delete</button>
        </div>`;
      }).join('')
      : '<p class="hint">No colors yet.</p>';
  });
}

/* ---------------------------------------------------------------- settings */

const SETTINGS = [
  { key: 'name', label: 'Calendar name', hint: 'The name subscribers see in their calendar app.' },
  { key: 'url', label: 'Public page address', hint: 'Linked from every calendar entry.' },
  { key: 'description', label: 'Description', full: true },
  { key: 'seasonStart', label: 'Season starts', type: 'date' },
  { key: 'seasonEnd', label: 'Season ends', type: 'date' },
  { key: 'timezone', label: 'Time zone', list: 'tz-list', hint: 'Meeting times are in this zone.' },
  { key: 'meetingTitle', label: 'Meeting title', hint: 'Used for meetings without their own title.' },
  { key: 'meetingLocation', label: 'Meeting location', hint: 'Usual meeting place (optional).' },
  { key: 'tbdTitle', label: 'TBD day title', hint: 'Shown for days whose time isn’t set yet.' },
  { key: 'includeTbd', label: 'Add TBD days to the calendar feed as all-day entries', type: 'checkbox', full: true },
];

function renderSettings() {
  const box = $('#settings');
  const cal = state.schedule.calendar;
  withFocusKept(box, () => {
    box.innerHTML = SETTINGS.map((f) => {
      if (f.type === 'checkbox') {
        return `<label class="check ${f.full ? 'full' : ''}"><input type="checkbox" data-setting="${f.key}" ${cal[f.key] ? 'checked' : ''}> ${escapeHtml(f.label)}</label>`;
      }
      return `<div class="field ${f.full ? 'full' : ''}">
        <label class="field-label" for="set-${f.key}">${escapeHtml(f.label)}</label>
        <input id="set-${f.key}" type="${f.type || 'text'}" data-setting="${f.key}" value="${escapeHtml(cal[f.key] ?? '')}" ${f.list ? `list="${f.list}"` : ''}>
        ${f.hint ? `<span class="hint">${escapeHtml(f.hint)}</span>` : ''}
      </div>`;
    }).join('');
  });
}

/* ================================================================ banners */

function showBanner(id, html, actions = []) {
  $(`#banners [data-banner="${id}"]`)?.remove();
  const el = document.createElement('div');
  el.className = 'banner';
  el.dataset.banner = id;
  el.innerHTML = `<p>${html}</p>`;
  for (const a of [...actions, { label: 'Dismiss', ghost: true }]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn btn-sm${a.ghost ? ' btn-ghost' : ''}`;
    b.textContent = a.label;
    b.addEventListener('click', () => {
      el.remove();
      a.onClick?.();
    });
    el.append(b);
  }
  $('#banners').append(el);
}
const hideBanner = (id) => $(`#banners [data-banner="${id}"]`)?.remove();

/* ================================================================ loading */

async function loadSchedule({ fromGitHub }) {
  const conn = getConn();
  if (fromGitHub) {
    try {
      return { ...(await fetchRemote(conn)), source: 'github' };
    } catch (err) {
      showBanner('load', `Couldn't load the schedule from GitHub: ${escapeHtml(explainGitHubError(err, conn))} Showing the copy from the website instead.`);
    }
  }
  const res = await fetch('schedule.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`schedule.json returned HTTP ${res.status}`);
  let text = await res.text();
  let sha = await gitBlobSha(text);
  // Right after publishing, the website still serves the old file for a minute or two.
  const recent = store.get(localStorage, KEYS.lastPublished);
  if (recent && sha && recent.prevSha === sha && Date.now() - recent.at < 30 * 60 * 1000) {
    text = recent.text;
    sha = recent.sha;
    showBanner('rebuilding', 'Showing the version you just published. The public site is still rebuilding and will catch up shortly.');
  }
  return { text, sha, source: 'site' };
}

async function init() {
  renderRepoLabel();
  const tzList = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  $('#tz-list').innerHTML = [...new Set(['America/Los_Angeles', 'America/Denver', 'America/Phoenix', 'America/Chicago', 'America/New_York', ...tzList])]
    .map((z) => `<option value="${escapeHtml(z)}">`).join('');

  const preferGitHub = Boolean(getToken()) || window.location.hostname.endsWith('.github.io');
  let loaded;
  try {
    loaded = await loadSchedule({ fromGitHub: preferGitHub });
  } catch (err) {
    showBanner('load-failed', `Couldn't load the schedule (${escapeHtml(err.message)}). You can still import a schedule.json file from the <b>More</b> menu.`);
    loaded = { text: serializeSchedule({}), sha: null };
  }

  setBase(loaded.text, loaded.sha);
  try {
    state.schedule = normalizeSchedule(JSON.parse(loaded.text));
  } catch (err) {
    showBanner('bad-json', `schedule.json isn't valid JSON (${escapeHtml(err.message)}). Fix it on GitHub or import a good copy.`);
    state.schedule = normalizeSchedule({});
  }
  state.loaded = true;

  const draft = store.get(localStorage, KEYS.draft);
  const draftNorm = draft?.text ? safeNormalizeText(draft.text) : null;
  if (draftNorm && draftNorm !== state.baseNorm) {
    const when = new Date(draft.savedAt).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const discard = () => store.remove(localStorage, KEYS.draft);
    if (!draft.baseSha || draft.baseSha === state.baseSha) {
      state.schedule = normalizeSchedule(JSON.parse(draft.text));
      showBanner('draft', `Restored your unpublished changes from ${escapeHtml(when)}.`, [
        { label: 'Discard them', onClick: () => discardChanges(false) },
      ]);
    } else {
      showBanner('draft', `You have unpublished changes from ${escapeHtml(when)}, but the schedule on GitHub has changed since then. Restoring them would replace those newer changes.`, [
        { label: 'Restore my changes', onClick: () => replaceSchedule(JSON.parse(draft.text)) },
        { label: 'Throw them away', onClick: discard },
      ]);
    }
  }

  render(['all']);
  afterChange();
}

function discardChanges(ask = true) {
  if (ask && isDirty() && !window.confirm('Throw away all unpublished changes?')) return;
  const base = state.baseNorm ? JSON.parse(state.baseNorm) : {};
  replaceSchedule(base);
  store.remove(localStorage, KEYS.draft);
  toast('Unpublished changes discarded (Undo brings them back)');
}

async function reloadFromGitHub() {
  if (isDirty() && !window.confirm('Load the latest schedule from GitHub? Your unpublished changes will be replaced (you can still Undo).')) return;
  const conn = getConn();
  try {
    const { text, sha } = await fetchRemote(conn);
    setBase(text, sha);
    replaceSchedule(JSON.parse(text));
    hideBanner('draft');
    hideBanner('rebuilding');
    toast('Loaded the latest schedule from GitHub');
  } catch (err) {
    toast(explainGitHubError(err, conn), 5000);
  }
}

/* ================================================================ publishing */

function describeEntry(e) {
  if (!e) return 'blank';
  if (e.status === 'meeting') return isTime(e.start) && isTime(e.end) ? formatTimeRange(e.start, e.end) : 'meeting';
  return e.status === 'tbd' ? 'TBD' : 'off';
}

function summarizeChanges() {
  let base;
  try {
    base = normalizeSchedule(JSON.parse(state.baseNorm || '{}'));
  } catch {
    base = normalizeSchedule({});
  }
  const cur = normalizeSchedule(state.schedule);
  const lines = [];
  const changedDays = [];
  for (const d of [...new Set([...Object.keys(base.days), ...Object.keys(cur.days)])].sort()) {
    const a = base.days[d];
    const b = cur.days[d];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    changedDays.push(d);
    const before = describeEntry(a);
    const after = describeEntry(b);
    lines.push(`${formatDate(d, 'medium')}: ${before === after ? `${after} (details changed)` : `${before} → ${after}`}`);
  }
  const baseEvents = new Map(base.events.map((e) => [e.id, e]));
  const curEvents = new Map(cur.events.map((e) => [e.id, e]));
  let eventChanges = 0;
  for (const [id, e] of curEvents) {
    const old = baseEvents.get(id);
    if (!old) lines.push(`Added event: ${e.title}`);
    else if (JSON.stringify(old) !== JSON.stringify(e)) lines.push(`Updated event: ${e.title}`);
    else continue;
    eventChanges += 1;
  }
  for (const [id, e] of baseEvents) {
    if (!curEvents.has(id)) {
      lines.push(`Removed event: ${e.title}`);
      eventChanges += 1;
    }
  }
  if (JSON.stringify(base.tags) !== JSON.stringify(cur.tags)) lines.push('Updated no-school colors');
  if (JSON.stringify(base.calendar) !== JSON.stringify(cur.calendar)) lines.push('Updated calendar settings');

  const bits = [];
  if (changedDays.length) {
    bits.push(changedDays.length === 1
      ? formatDate(changedDays[0], 'medium')
      : `${plural(changedDays.length, 'day')}, ${formatDateRange(changedDays[0], changedDays[changedDays.length - 1])}`);
  }
  if (eventChanges) bits.push(plural(eventChanges, 'event'));
  const subject = bits.length ? `Update schedule: ${bits.join('; ')}` : 'Update schedule settings';
  return { lines, subject };
}

function fillConnFields() {
  const conn = getConn();
  const token = getToken();
  $('#p-repo').value = conn.repo;
  $('#p-branch').value = conn.branch;
  $('#p-path').value = conn.path;
  $('#p-token').value = token;
  $('#p-remember').checked = Boolean(store.get(localStorage, KEYS.token));
  $('#p-conn').open = !token;
  const [owner, repo] = conn.repo.split('/');
  for (const el of $$('.js-owner')) el.textContent = owner || 'the repository owner';
  for (const el of $$('.js-repo')) el.textContent = repo || 'this repository';
  $('#p-conn-summary').textContent = `${conn.repo}${conn.branch ? ` @ ${conn.branch}` : ''} · ${token ? 'token saved' : 'token needed'}`;
}

function readConnFields() {
  const conn = {
    repo: $('#p-repo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, ''),
    branch: $('#p-branch').value.trim(),
    path: $('#p-path').value.trim().replace(/^\/+/, '') || 'schedule.json',
  };
  return { conn, token: $('#p-token').value.trim(), remember: $('#p-remember').checked };
}

function setPublishStatus(html, kind = '') {
  const el = $('#p-status');
  el.className = `status-line${kind ? ` is-${kind}` : ''}`;
  el.innerHTML = html;
}

function openPublish() {
  if (!state.loaded) return;
  if (state.errors.length) {
    toast('Fix the problems listed in the side panel before publishing', 4000);
    clearSelection();
    return;
  }
  if (!isDirty()) {
    toast('Nothing to publish — the schedule matches GitHub');
    return;
  }
  const { lines, subject } = summarizeChanges();
  $('#publish-changes').innerHTML = lines.length
    ? `<ul class="change-list">${lines.slice(0, 40).map((l) => `<li>${escapeHtml(l)}</li>`).join('')}${lines.length > 40 ? `<li>…and ${lines.length - 40} more</li>` : ''}</ul>`
    : '';
  $('#p-message').value = subject;
  fillConnFields();
  setPublishStatus('');
  const go = $('#p-go');
  go.disabled = false;
  go.textContent = 'Publish';
  go.dataset.done = '';
  $('#publish-dialog').showModal();
}

async function publish() {
  const go = $('#p-go');
  if (go.dataset.done) {
    $('#publish-dialog').close();
    return;
  }
  const { conn, token, remember } = readConnFields();
  if (!/^[\w.-]+\/[\w.-]+$/.test(conn.repo)) {
    setPublishStatus('Enter the repository as owner/name, for example HotwireRobotics/web-cal.', 'error');
    $('#p-conn').open = true;
    return;
  }
  if (!token) {
    setPublishStatus('An access token is needed to publish. See “How do I get a token?” below.', 'error');
    $('#p-conn').open = true;
    $('#p-token').focus();
    return;
  }
  saveConn(conn);
  saveToken(token, remember);

  const text = serializeSchedule(state.schedule);
  const { lines } = summarizeChanges();
  const subject = $('#p-message').value.trim() || 'Update schedule';
  const message = `${subject}\n\n${lines.map((l) => `- ${l}`).join('\n')}\n\nPublished from the schedule editor.`.trim();

  go.disabled = true;
  setPublishStatus('Checking GitHub…');
  try {
    let remote = null;
    try {
      remote = await fetchRemote(conn);
    } catch (err) {
      if (err.status !== 404) throw err;
      // 404 can mean "file doesn't exist yet" (fine) or "repo not visible" (the PUT will say so).
    }
    if (remote && state.baseSha && remote.sha !== state.baseSha) {
      const remoteNorm = safeNormalizeText(remote.text);
      if (remoteNorm !== state.baseNorm && remoteNorm !== text) {
        const ok = window.confirm(
          'The schedule on GitHub was changed after you opened the editor (by someone else, or in another tab).\n\n'
          + 'Publishing now replaces those changes with yours. To keep them, cancel, then use More → “Load latest from GitHub” and redo your edits.\n\nPublish anyway?',
        );
        if (!ok) {
          setPublishStatus('Publishing cancelled.');
          go.disabled = false;
          return;
        }
      }
    }
    setPublishStatus('Publishing…');
    const result = await gh(contentsPath(conn), {
      token,
      method: 'PUT',
      body: {
        message,
        content: utf8ToBase64(text),
        ...(remote ? { sha: remote.sha } : {}),
        ...(conn.branch ? { branch: conn.branch } : {}),
      },
    });
    store.set(localStorage, KEYS.lastPublished, { text, sha: result.content.sha, prevSha: remote?.sha || state.baseSha, at: Date.now() });
    setBase(text, result.content.sha);
    store.remove(localStorage, KEYS.draft);
    hideBanner('draft');
    afterChange();
    const actionsUrl = `https://github.com/${conn.repo}/actions`;
    setPublishStatus(
      `Published! The website and calendar feeds update in a minute or two. <a href="${escapeHtml(result.commit.html_url)}" target="_blank" rel="noopener">View change</a> · <a href="${actionsUrl}" target="_blank" rel="noopener">Deploy progress</a>`,
      'ok',
    );
    go.textContent = 'Close';
    go.dataset.done = '1';
    go.disabled = false;
  } catch (err) {
    setPublishStatus(escapeHtml(explainGitHubError(err, conn)), 'error');
    if ([401, 403, 404].includes(err.status)) $('#p-conn').open = true;
    go.disabled = false;
  }
}

async function publishViaGitHubEditor() {
  const conn = getConn();
  let branch = conn.branch;
  if (!branch) {
    try {
      branch = (await gh(`/repos/${conn.repo}`)).default_branch;
    } catch {
      branch = 'main';
    }
  }
  const ok = await copyText(serializeSchedule(state.schedule));
  window.open(`https://github.com/${conn.repo}/edit/${encodeURIComponent(branch)}/${conn.path}`, '_blank', 'noopener');
  toast(ok
    ? 'Schedule copied. On GitHub: select all the text, paste, then click “Commit changes”.'
    : "Couldn't copy automatically. Use “Download schedule.json” and upload it on GitHub instead.", 8000);
}

/* ================================================================ event wiring */

function clearSelection() {
  setSelection([], { anchor: null });
}

/** Dates shown on the grid, in order. Collapsed empty weeks outside the season aren't included. */
function visibleDates() {
  return $$('#grid .day[data-date]').map((el) => el.dataset.date);
}

/** The visible dates from a to b (either order), for Shift-click and drag selection. */
function rangeDates(a, b) {
  const [start, end] = a <= b ? [a, b] : [b, a];
  return visibleDates().filter((d) => d >= start && d <= end);
}

function wireGrid() {
  const grid = $('#grid');
  let drag = null; // { anchor, base:Set }
  let pointerHandled = false;

  const select = (date, { shift, toggle }) => {
    if (shift && state.anchor) {
      const base = toggle ? state.selected : new Set();
      setSelection([...base, ...rangeDates(state.anchor, date)]);
    } else if (toggle) {
      const next = new Set(state.selected);
      if (next.has(date)) next.delete(date);
      else next.add(date);
      setSelection(next, { anchor: date });
    } else {
      setSelection([date], { anchor: date });
    }
  };

  grid.addEventListener('pointerdown', (e) => {
    const cell = e.target.closest('.day[data-date]');
    if (!cell || e.pointerType !== 'mouse' || e.button !== 0) return;
    pointerHandled = true;
    const date = cell.dataset.date;
    const toggle = e.ctrlKey || e.metaKey;
    select(date, { shift: e.shiftKey, toggle });
    if (!e.shiftKey) drag = { anchor: date, base: toggle ? new Set(state.selected) : new Set(), moved: false };
  });
  grid.addEventListener('pointerover', (e) => {
    if (!drag) return;
    const cell = e.target.closest('.day[data-date]');
    if (!cell || (cell.dataset.date === drag.anchor && !drag.moved)) return;
    drag.moved = true;
    state.selected = new Set([...drag.base, ...rangeDates(drag.anchor, cell.dataset.date)]);
    paintSelection();
  });
  window.addEventListener('pointerup', () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (moved) renderPanel();
  });

  grid.addEventListener('click', (e) => {
    const cell = e.target.closest('.day[data-date]');
    if (cell) {
      if (pointerHandled) {
        pointerHandled = false;
        return;
      }
      select(cell.dataset.date, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey });
      return;
    }
    const dow = e.target.closest('[data-weekday]');
    if (dow) {
      const wd = Number(dow.dataset.weekday);
      // Leave out blank days outside the season (e.g. the rest of kickoff week), so "every
      // Thursday is 6–9 PM" doesn't quietly add pre-season meetings.
      const dates = $$('#grid .day[data-date]:not(.is-outside.is-empty)')
        .map((el) => el.dataset.date)
        .filter((d) => weekday(d) === wd);
      setSelection(e.shiftKey || e.ctrlKey || e.metaKey ? [...state.selected, ...dates] : dates, { anchor: dates[0] });
      return;
    }
    const ev = e.target.closest('[data-event-id]');
    if (ev) selectEventDays(ev.dataset.eventId);
  });
}

function wirePanel() {
  const panel = $('#panel');
  panel.addEventListener('click', (e) => {
    const statusBtn = e.target.closest('[data-status]');
    if (statusBtn) return applyStatus(statusBtn.dataset.status);
    const chip = e.target.closest('.chip[data-start]');
    if (chip) {
      applyTimes({ start: chip.dataset.start, end: chip.dataset.end });
      return renderPanel();
    }
    if (e.target.closest('[data-action="deselect"]')) clearSelection();
  });
  panel.addEventListener('change', (e) => {
    const t = e.target;
    if (t.id === 'f-start' || t.id === 'f-end') {
      if (!isTime(t.value)) return;
      applyTimes(t.id === 'f-start' ? { start: t.value } : { end: t.value });
      refreshPanelPreview();
    } else if (t.dataset.tag) {
      applyTag(t.dataset.tag, t.checked);
    }
  });
  panel.addEventListener('input', (e) => {
    const field = e.target.dataset.text;
    if (!field) return;
    applyText(field, e.target.value);
    refreshPanelPreview();
  });
}

function wireEvents() {
  const list = $('#events');
  const update = (e, rerender) => {
    const row = e.target.closest('.ev-row');
    const field = e.target.dataset.field;
    if (!row || !field) return;
    const id = row.dataset.id;
    change((s) => {
      const ev = s.events.find((x) => x.id === id);
      if (!ev) return;
      if (field === 'attending') ev.attending = e.target.checked;
      else if (field === 'start' || field === 'end') {
        if (!isDate(e.target.value)) return;
        ev[field] = e.target.value;
        if (field === 'start' && (!isDate(ev.end) || ev.end < ev.start)) ev.end = ev.start;
        if (field === 'end' && ev.end < ev.start) ev.start = ev.end;
      } else {
        const v = e.target.value.trim();
        if (v || field === 'title') ev[field] = v;
        else delete ev[field];
      }
    }, { coalesce: rerender ? null : `event:${id}:${field}`, parts: rerender ? ['grid', 'events', 'panel'] : ['grid'] });
  };
  list.addEventListener('input', (e) => {
    if (e.target.type === 'text') update(e, false);
  });
  list.addEventListener('change', (e) => {
    if (e.target.type === 'date' || e.target.type === 'checkbox') update(e, true);
  });
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.ev-row');
    if (!row) return;
    const id = row.dataset.id;
    if (e.target.closest('[data-action="select-event"]')) {
      selectEventDays(id);
      $('#days-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (e.target.closest('[data-action="delete-event"]')) {
      const ev = findEvent(id);
      if (!window.confirm(`Delete “${ev?.title || 'this event'}”?`)) return;
      change((s) => {
        s.events = s.events.filter((x) => x.id !== id);
      }, { parts: ['grid', 'events', 'panel'] });
      toast('Event deleted (Undo brings it back)');
    }
  });
}

function wireTags() {
  const list = $('#tags');
  list.addEventListener('input', (e) => {
    const row = e.target.closest('.tag-row');
    const field = e.target.dataset.field;
    if (!row || !field) return;
    const id = row.dataset.id;
    change((s) => {
      const tag = s.tags.find((t) => t.id === id);
      if (tag) tag[field] = field === 'color' ? e.target.value.toLowerCase() : e.target.value;
    }, { coalesce: `tag:${id}:${field}`, parts: ['grid'] });
  });
  list.addEventListener('change', (e) => {
    if (e.target.closest('.tag-row')) renderPanel();
  });
  list.addEventListener('click', (e) => {
    if (!e.target.closest('[data-action="delete-tag"]')) return;
    const id = e.target.closest('.tag-row').dataset.id;
    const s = state.schedule;
    const tag = s.tags.find((t) => t.id === id);
    const used = Object.values(s.days).filter((d) => d.tags?.includes(id)).length;
    if (used && !window.confirm(`Remove “${tag.label}”? It will be taken off ${plural(used, 'day')}.`)) return;
    change((sch) => {
      sch.tags = sch.tags.filter((t) => t.id !== id);
      for (const day of Object.values(sch.days)) {
        if (!day.tags) continue;
        day.tags = day.tags.filter((t) => t !== id);
        if (!day.tags.length) delete day.tags;
      }
    }, { parts: ['grid', 'tags', 'panel'] });
  });
}

function addTag() {
  const s = state.schedule;
  const id = uniqueId('no-school', new Set(s.tags.map((t) => t.id)));
  const palette = ['#d7cdf3', '#f6e7a1', '#bfe3e0', '#f3c1c1', '#cfd8e3'];
  change((sch) => {
    sch.tags.push({ id, label: 'No School', color: palette[sch.tags.length % palette.length] });
  }, { parts: ['grid', 'tags', 'panel'] });
  const input = $(`#tags [data-id="${id}"] [data-field="label"]`);
  input?.focus();
  input?.select();
}

function wireSettings() {
  const box = $('#settings');
  const update = (e, coalesce) => {
    const key = e.target.dataset.setting;
    if (!key) return;
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (e.target.type === 'date' && value && !isDate(value)) return;
    change((s) => {
      s.calendar[key] = typeof value === 'string' ? value.trim() : value;
    }, { coalesce: coalesce ? `setting:${key}` : null, parts: ['grid', 'panel'] });
  };
  box.addEventListener('input', (e) => {
    if (e.target.type === 'text') update(e, true);
  });
  box.addEventListener('change', (e) => {
    if (e.target.type === 'date' || e.target.type === 'checkbox') update(e, false);
  });
}

function wireToolbar() {
  $('#undo-btn').addEventListener('click', undo);
  $('#redo-btn').addEventListener('click', redo);
  $('#publish-btn').addEventListener('click', openPublish);

  const menu = $('#more-menu');
  document.addEventListener('click', (e) => {
    if (menu.open && !menu.contains(e.target)) menu.open = false;
  });

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (menu.contains(btn)) menu.open = false;
    switch (action) {
      case 'reload': return reloadFromGitHub();
      case 'discard': return discardChanges(true);
      case 'download-json': return download('schedule.json', serializeSchedule(state.schedule), 'application/json');
      case 'import-json': return $('#import-file').click();
      case 'download-ics': return download('calendar-preview.ics', buildIcs(state.schedule), 'text/calendar');
      case 'github-editor': return publishViaGitHubEditor();
      case 'add-event': return addEvent();
      case 'add-tag': return addTag();
      default: return undefined;
    }
  });

  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const imported = normalizeSchedule(JSON.parse(await file.text()));
      replaceSchedule(imported);
      const problems = validateSchedule(imported);
      toast(problems.length ? `Imported with ${plural(problems.length, 'problem')} to fix` : 'Schedule imported. Publish to make it live.', 4000);
    } catch (err) {
      toast(`That file isn't a valid schedule (${err.message})`, 5000);
    }
  });

  const dialog = $('#publish-dialog');
  $('#publish-form').addEventListener('submit', (e) => {
    e.preventDefault();
    publish();
  });
  $('#p-cancel').addEventListener('click', () => dialog.close());

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 's') {
      e.preventDefault();
      if (!dialog.open) openPublish();
      return;
    }
    if (dialog.open || e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (mod && key === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && key === 'y') {
      e.preventDefault();
      redo();
    } else if (e.key === 'Escape' && state.selected.size) {
      clearSelection();
    }
  });
}

$('#add-day-form').addEventListener('submit', (e) => {
  e.preventDefault();
  addDay($('#add-day-date').value);
});

wireGrid();
wirePanel();
wireEvents();
wireTags();
wireSettings();
wireToolbar();
init();
