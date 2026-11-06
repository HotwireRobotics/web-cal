// Builds the GitHub Pages site into _site/:
//   site/*            → _site/*            (the public page)
//   libraries         → _site/vendor/*     (from node_modules, for the browser)
//   schedule.json     → _site/schedule.json
//   generated feeds   → _site/calendar.ics, _site/competitions.ics
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEEDS, buildIcs, normalizeSchedule, validateSchedule } from '../site/assets/core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '_site');

const text = readFileSync(join(root, 'schedule.json'), 'utf8');
let raw;
try {
  raw = JSON.parse(text);
} catch (err) {
  console.error(`schedule.json is not valid JSON: ${err.message}`);
  process.exit(1);
}
const schedule = normalizeSchedule(raw);
const errors = validateSchedule(schedule);
if (errors.length) {
  console.error(`schedule.json has ${errors.length} problem(s):\n  - ${errors.join('\n  - ')}`);
  process.exit(1);
}

if (existsSync(out)) rmSync(out, { recursive: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, 'site'), out, { recursive: true });
writeFileSync(join(out, 'schedule.json'), text);

// Browser copies of the libraries, with their licenses. The import map in index.html points at
// these files. Paths on the left are inside node_modules/<library>/.
const VENDOR = {
  luxon: { 'build/es6/luxon.mjs': 'luxon.js', 'LICENSE.md': 'luxon-LICENSE.md' },
  'ical-generator': { 'dist/index.mjs': 'ical-generator.js', LICENSE: 'ical-generator-LICENSE.txt' },
  'simple-calendar-js': {
    'dist/simple-calendar-js.min.js': 'simple-calendar-js.js',
    'dist/simple-calendar-js.min.css': 'simple-calendar-js.css',
    LICENSE: 'simple-calendar-js-LICENSE.txt',
  },
};
for (const [library, files] of Object.entries(VENDOR)) {
  for (const [from, to] of Object.entries(files)) {
    cpSync(join(root, 'node_modules', library, from), join(out, 'vendor', to));
  }
}

const now = new Date();
for (const feed of FEEDS) {
  const ics = buildIcs(schedule, { feed: feed.id, now });
  writeFileSync(join(out, feed.file), ics);
  console.log(`${feed.file}: ${ics.split('BEGIN:VEVENT').length - 1} events`);
}

writeFileSync(
  join(out, 'build-info.json'),
  `${JSON.stringify({ builtAt: now.toISOString(), commit: process.env.GITHUB_SHA || null }, null, 2)}\n`,
);
writeFileSync(join(out, '.nojekyll'), '');
console.log(`Built ${Object.keys(schedule.days).length} days and ${schedule.events.length} events into _site/`);
