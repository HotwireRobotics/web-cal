// Renders the week-by-week schedule grid (shared by the public page and the editor).
import { WEEKDAYS, WEEKDAYS_SHORT, buildWeeks, describeDay, formatDate, formatDateRange, weekday } from './core.js';

export const escapeHtml = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Background for a day: one tag → solid colour, several → diagonal stripes of each. */
export function tagBackground(tags) {
  if (!tags.length) return '';
  if (tags.length === 1) return tags[0].color;
  const step = 100 / tags.length;
  const stops = tags.map((t, i) => `${t.color} ${(i * step).toFixed(2)}% ${((i + 1) * step).toFixed(2)}%`);
  return `linear-gradient(135deg, ${stops.join(', ')})`;
}

export function legendHtml(s) {
  const items = s.tags.map(
    (t) => `<li><span class="swatch" style="background:${escapeHtml(t.color)}"></span>${escapeHtml(t.label)}</li>`,
  );
  items.push('<li><span class="swatch swatch-comp"></span>Competition</li>');
  return `<ul class="legend">${items.join('')}</ul>`;
}

function dayHtml(s, date, { today, selected, editable }) {
  const info = describeDay(s, date);
  const classes = ['day'];
  if (info.status) classes.push(`is-${info.status}`);
  else classes.push('is-empty');
  if (info.tags.length) classes.push('has-tags');
  if (info.attendingEvent) classes.push('is-comp');
  if (today && date === today) classes.push('is-today');
  if (today && date < today) classes.push('is-past');
  if (selected?.has(date)) classes.push('is-selected');
  if (date.endsWith('-01')) classes.push('is-month-start');

  const bg = tagBackground(info.tags);
  const tooltip = [
    formatDate(date, 'long'),
    info.status ? `${info.title}${info.status === 'off' ? '' : ` · ${info.timeLabel}`}` : '',
    ...info.tags.map((t) => t.label),
    info.entry?.location ? `Location: ${info.entry.location}` : '',
    info.entry?.notes || '',
  ].filter(Boolean).join('\n');

  const parts = [
    `<span class="day-dow">${WEEKDAYS_SHORT[weekday(date)]}</span>`,
    `<span class="day-date">${formatDate(date)}</span>`,
    // On narrow screens "11 AM–7 PM" may only wrap after the dash, never before "PM".
    `<span class="day-time">${info.status ? escapeHtml(info.timeLabel).replace(/ /g, '&nbsp;').replace('–', '–<wbr>') : editable ? '<span class="day-blank">—</span>' : ''}</span>`,
  ];
  if (info.entry?.title) parts.push(`<span class="day-title">${escapeHtml(info.entry.title)}</span>`);
  if (info.entry?.notes) parts.push(`<span class="day-notes">${escapeHtml(info.entry.notes)}</span>`);
  if (info.tags.length) parts.push(`<span class="sr-only">${escapeHtml(info.tags.map((t) => t.label).join(', '))}</span>`);

  const tag = editable ? 'button' : 'div';
  const attrs = [
    `class="${classes.join(' ')}"`,
    `data-date="${date}"`,
    bg ? `style="--day-bg:${escapeHtml(bg)}"` : '',
    `title="${escapeHtml(tooltip)}"`,
    editable ? `type="button" aria-pressed="${selected?.has(date) ? 'true' : 'false'}"` : '',
  ].filter(Boolean);
  return `<${tag} ${attrs.join(' ')}>${parts.join('')}</${tag}>`;
}

function eventLabelHtml(ev, editable) {
  const meta = [formatDateRange(ev.start, ev.end), ev.location].filter(Boolean).map(escapeHtml).join(' · ');
  const tag = editable ? 'button' : 'div';
  const attrs = editable ? ` type="button" data-event-id="${escapeHtml(ev.id)}" title="Select these days"` : '';
  return `<${tag} class="wk-ev ${ev.attending ? 'is-attending' : 'is-other'}"${attrs}>
    <span class="wk-ev-title">${escapeHtml(ev.title || 'Untitled event')}</span>
    <span class="wk-ev-meta">${meta}${ev.attending ? '' : ' · not attending'}</span>
  </${tag}>`;
}

export function gridHtml(s, { today = null, selected = null, editable = false } = {}) {
  const weeks = buildWeeks(s);
  if (!weeks.length) return '<p class="empty-state">No days on the schedule yet.</p>';
  const head = WEEKDAYS_SHORT.map((d, i) =>
    editable
      ? `<button type="button" class="cal-dow" data-weekday="${i}" title="Select every ${WEEKDAYS[i]}">${d}</button>`
      : `<div class="cal-dow">${d}</div>`,
  ).join('');
  const rows = weeks.map((week) => {
    const cls = ['week'];
    if (today && week.end < today) cls.push('is-past');
    if (today && week.start <= today && today <= week.end) cls.push('is-current');
    return `<div class="${cls.join(' ')}" data-week="${week.start}">
      <div class="week-head">Week of ${formatDate(week.start)}</div>
      ${week.dates.map((d) => dayHtml(s, d, { today, selected, editable })).join('')}
      <div class="week-events">${week.events.map((ev) => eventLabelHtml(ev, editable)).join('')}</div>
    </div>`;
  });
  return `<div class="cal${editable ? ' is-editable' : ''}">
    <div class="cal-head">${head}<div class="cal-dow cal-ev-head">Events</div></div>
    ${rows.join('')}
  </div>`;
}
