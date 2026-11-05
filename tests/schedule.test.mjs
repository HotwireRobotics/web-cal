import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildIcs, buildWeeks, describeDay, formatTimeRange, normalizeSchedule, serializeSchedule, validateSchedule, zonedToUtc,
} from '../site/assets/core.js';

const raw = JSON.parse(readFileSync(new URL('../schedule.json', import.meta.url), 'utf8'));
const schedule = normalizeSchedule(raw);
const NOW = new Date('2026-11-05T12:00:00Z');

const events = (ics) => ics.split('BEGIN:VEVENT').slice(1).map((block) => {
  const unfolded = block.replace(/\r\n /g, '');
  const props = {};
  for (const line of unfolded.split('\r\n')) {
    const m = line.match(/^([A-Z-]+)(;[^:]*)?:(.*)$/);
    if (m) props[m[1]] = m[3];
  }
  return props;
});

test('schedule.json is valid', () => {
  assert.deepEqual(validateSchedule(schedule), []);
});

test('schedule.json is stored in the canonical format the editor writes', () => {
  assert.equal(readFileSync(new URL('../schedule.json', import.meta.url), 'utf8'), serializeSchedule(raw));
});

test('serialize → parse round-trips', () => {
  assert.deepEqual(normalizeSchedule(JSON.parse(serializeSchedule(schedule))), schedule);
});

test('weeks cover the whole season, Sunday to Saturday', () => {
  const weeks = buildWeeks(schedule);
  assert.equal(weeks[0].start, '2027-01-10');
  assert.equal(weeks.at(-1).end, '2027-05-01');
  assert.equal(weeks.length, 16);
});

test('converts local meeting times to UTC across the DST change', () => {
  // 6 PM PST on Jan 11 2027
  assert.equal(zonedToUtc('2027-01-11', '18:00', 'America/Los_Angeles').toISOString(), '2027-01-12T02:00:00.000Z');
  // DST starts 2 AM Mar 14 2027: 7 AM that morning is already PDT
  assert.equal(zonedToUtc('2027-03-14', '07:00', 'America/Los_Angeles').toISOString(), '2027-03-14T14:00:00.000Z');
  assert.equal(zonedToUtc('2027-03-13', '21:00', 'America/Los_Angeles').toISOString(), '2027-03-14T05:00:00.000Z');
});

test('formats time ranges like the paper schedule', () => {
  assert.equal(formatTimeRange('18:00', '21:00'), '6–9 PM');
  assert.equal(formatTimeRange('11:00', '19:00'), '11 AM–7 PM');
  assert.equal(formatTimeRange('07:00', '21:00'), '7 AM–9 PM');
  assert.equal(formatTimeRange('18:30', '21:00'), '6:30–9 PM');
});

test('competition days take the competition name', () => {
  assert.equal(describeDay(schedule, '2027-03-12').title, 'Wilsonville (Week 2)');
  assert.equal(describeDay(schedule, '2027-03-11').title, 'Robotics Meeting');
  assert.equal(describeDay(schedule, '2027-03-19').attendingEvent, null); // Week 3: not attending
});

test('full feed has meetings, TBD days and attended competitions', () => {
  const ics = buildIcs(schedule, { now: NOW });
  const list = events(ics);
  const meetings = Object.values(schedule.days).filter((d) => d.status === 'meeting').length;
  const comps = schedule.events.filter((e) => e.attending).length;
  const tbdOutsideComps = Object.keys(schedule.days)
    .filter((d) => schedule.days[d].status === 'tbd' && !describeDay(schedule, d).attendingEvent).length;
  assert.equal(list.length, meetings + comps + tbdOutsideComps);
  assert.equal(new Set(list.map((e) => e.UID)).size, list.length, 'UIDs are unique');

  const first = list.find((e) => e.UID.startsWith('day-2027-01-10@'));
  assert.equal(first.DTSTART, '20270110T210000Z'); // 1 PM PST
  assert.equal(first.DTEND, '20270111T010000Z'); // 5 PM PST
  assert.equal(first.SUMMARY, 'Robotics Meeting');

  const houston = list.find((e) => e.UID.startsWith('event-week-9@'));
  assert.equal(houston.DTSTART, '20270425');
  assert.equal(houston.DTEND, '20270503'); // exclusive end → through May 2

  assert.ok(!list.some((e) => e.UID.startsWith('event-week-3@')), 'non-attending weeks are left out');
  assert.ok(!list.some((e) => e.UID.startsWith('day-2027-01-14@')), 'days off are left out');

  const noSchool = list.find((e) => e.UID.startsWith('day-2027-01-25@'));
  assert.match(noSchool.DESCRIPTION, /No School Stayton\\, No School Cascade/);
});

test('competitions feed only has competitions and their hours', () => {
  const list = events(buildIcs(schedule, { feed: 'competitions', now: NOW }));
  assert.ok(list.length > 0);
  for (const e of list) {
    const date = e.UID.match(/^day-(\d{4}-\d{2}-\d{2})/)?.[1];
    if (date) assert.ok(describeDay(schedule, date).attendingEvent, `${date} should be a competition day`);
  }
  assert.ok(list.every((e) => e.UID.includes('.competitions@')));
});

test('TBD days can be left out of the feed', () => {
  const s = normalizeSchedule({ ...raw, calendar: { ...raw.calendar, includeTbd: false } });
  const list = events(buildIcs(s, { now: NOW }));
  assert.ok(!list.some((e) => e.SUMMARY === s.calendar.tbdTitle));
});

test('ics output follows RFC 5545 line rules', () => {
  const s = normalizeSchedule({
    ...raw,
    days: { '2027-01-11': { status: 'meeting', start: '18:00', end: '21:00', title: 'Build, test; ship \\ repeat', notes: `Line one\nLine two ${'é'.repeat(80)}` } },
  });
  const ics = buildIcs(s, { now: NOW });
  assert.ok(ics.endsWith('\r\n'));
  assert.ok(!/[^\r]\n/.test(ics), 'only CRLF line breaks');
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `line too long: ${line}`);
  const ev = events(ics).find((e) => e.UID.startsWith('day-2027-01-11@'));
  assert.equal(ev.SUMMARY, 'Build\\, test\\; ship \\\\ repeat');
  assert.match(ev.DESCRIPTION, /^Line one\\nLine two é+/);
});

test('validation catches common mistakes', () => {
  const bad = normalizeSchedule({
    ...raw,
    events: [{ id: 'x', title: '', start: '2027-03-05', end: '2027-03-01' }],
    days: {
      '2027-01-11': { status: 'meeting', start: '21:00', end: '18:00' },
      '2027-01-12': { status: 'meeting' },
      '2027-01-13': { status: 'off', tags: ['nope'] },
    },
  });
  const errors = validateSchedule(bad);
  assert.equal(errors.length, 5, errors.join('\n'));
});
