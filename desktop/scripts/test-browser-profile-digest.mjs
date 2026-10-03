/**
 * The browsing digest for "About you" (electron/browser-profile-digest.ts,
 * ADR 0018) on synthetic learn data: what may leave the browser's store for
 * the engine's learner, and what must not.
 *
 * Proves: registrable domains only (no subdomain, path or query); categories
 * from the table; minutes/visits in the 30-day window; search *words*, never
 * whole queries; sensitive domains, titles and searches dropped in code;
 * excluded sites left out; paused learning and the "use my browsing" switch
 * write nothing but the flag; reading style; the switch file round-trips.
 *
 *   node scripts/test-browser-profile-digest.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-desk-digest-'));

async function load(entry, name) {
  const file = path.join(out, `${name}.mjs`);
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: file, logLevel: 'error', external: ['electron'] });
  return import(pathToFileURL(file).href);
}

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

const L = await load(path.join(desktop, 'electron/browser-learn-core.ts'), 'learn');
const G = await load(path.join(desktop, 'electron/browser-profile-digest.ts'), 'digest');
const { DAY } = L;
const MIN = 60_000;
const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 9, 30, 20, 0);
const visit = (d, url, t, o = {}) => L.learnVisit(d, { url, title: o.title ?? '', fromUrl: o.from }, t);
const read = (d, url, t, minutes, scroll) => { for (let i = 0; i < minutes; i++) L.learnActive(d, url, 60_000, t + i * MIN, scroll); };

function sample() {
  const d = L.emptyLearn(NOW - 50 * DAY);
  for (let day = 1; day <= 12; day++) {
    const t = NOW - day * DAY - 2 * 3600_000;
    visit(d, `https://github.com/acme/repo/pull/${day}`, t, { title: 'Fix the parser · acme/repo' });
    read(d, `https://github.com/acme/repo/pull/${day}`, t, 6, 0.9);
    visit(d, 'https://docs.python.org/3/library/asyncio.html', t + 20 * MIN, { title: 'asyncio — Asynchronous I/O' });
    read(d, 'https://docs.python.org/3/library/asyncio.html', t + 20 * MIN, 4, 0.8);
  }
  visit(d, 'https://gist.github.com/me/abc123?secret=1', NOW - 3 * DAY, { title: 'my gist' });
  visit(d, 'https://www.youtube.com/watch?v=x', NOW - 2 * DAY, { title: 'Rust async explained' });
  read(d, 'https://www.youtube.com/watch?v=x', NOW - 2 * DAY, 3, 0.1);
  // Searches: one ordinary, one sensitive.
  visit(d, 'https://www.google.com/search?q=python+asyncio+timeout', NOW - 4 * DAY);
  visit(d, 'https://www.google.com/search?q=python+asyncio+cancel', NOW - 3 * DAY);
  visit(d, 'https://www.google.com/search?q=diabetes+symptoms+in+adults', NOW - 3 * DAY);
  // Sensitive sites, a sensitive page on an ordinary site, an excluded site, an old visit.
  visit(d, 'https://www.webmd.com/diabetes/guide', NOW - 1 * DAY, { title: 'Diabetes guide' });
  read(d, 'https://www.webmd.com/diabetes/guide', NOW - 1 * DAY, 9, 0.9);
  visit(d, 'https://www.chase.com/personal/checking', NOW - 1 * DAY, { title: 'Checking accounts' });
  visit(d, 'https://www.reddit.com/r/Christianity/', NOW - 1 * DAY, { title: 'Christianity subreddit' });
  visit(d, 'https://secret.example.org/x', NOW - 1 * DAY, { title: 'Excluded' });
  L.setExcluded(d, 'example.org', true);
  d.excluded.push('example.org');
  visit(d, 'https://secret.example.org/y', NOW - 1 * DAY, { title: 'Recorded before exclusion' });
  visit(d, 'https://old.news.site/a', NOW - 45 * DAY, { title: 'Old news' });
  visit(d, 'http://192.168.1.10/admin', NOW - 1 * DAY, { title: 'Router' });
  return d;
}

console.log('\nDomains and categories');
{
  ok(G.registrableDomain('gist.github.com') === 'github.com' && G.registrableDomain('www.bbc.co.uk') === 'bbc.co.uk', 'registrable domain: subdomains folded, two-label suffixes kept');
  ok(G.registrableDomain('192.168.1.10') === '' && G.registrableDomain('localhost') === 'localhost', 'IP addresses are never a domain; localhost is local development');
  ok(G.categoryOf('github.com') === 'code hosting' && G.categoryOf('docs.python.org') === 'developer docs' && G.categoryOf('youtube.com') === 'video', 'categories from the table');
  ok(G.categoryOf('webmd.com') === null && G.categoryOf('chase.com') === null && G.categoryOf('maps.google.com') === null, 'sensitive sites have no category (left out)');
  ok(G.categoryOf('tinder.com') === null && G.categoryOf('mybank.example') === null, 'dating and banking hosts are left out');
}

console.log('\nThe digest');
{
  const g = G.buildDigest(sample(), NOW);
  const json = JSON.stringify(g);
  const domains = g.domains.map(x => x.domain);
  ok(domains.includes('github.com') && domains.includes('python.org'), 'ordinary domains are kept', domains);
  ok(!/gist\.|\/acme|\/library|secret=|\?|https?:/.test(json), 'no subdomain, path, query or address anywhere in the file');
  ok(!/webmd|chase|diabetes|christian/i.test(json), 'sensitive sites, pages and searches are dropped in code', json.match(/webmd|chase|diabetes|christian/gi));
  ok(!domains.includes('example.org') && !/example\.org/.test(json), 'excluded sites are left out');
  ok(!/old\.news|site/.test(domains.join(' ')), 'a visit older than the window does not count');
  ok(!domains.includes(''), 'IP addresses are never in the digest');
  ok(g.dropped.sensitive >= 3 && g.dropped.excluded >= 1, 'it says how much it left out', g.dropped);
  const gh = g.domains.find(x => x.domain === 'github.com');
  ok(gh && gh.category === 'code hosting' && gh.minutes >= 60 && gh.days >= 10, 'minutes and days in the window', gh);
  const terms = g.searchTerms.map(x => x.term);
  ok(terms.includes('asyncio') && terms.includes('python') && !terms.includes('symptom') && !terms.includes('adult'), 'search words counted; a sensitive search is dropped whole', terms);
  ok(!/python asyncio timeout/.test(json), 'never a whole query');
  ok(g.searchTerms.find(x => x.term === 'asyncio')?.count === 2, 'a word repeated across searches is counted');
  ok(g.routines.hours.length === 24 && g.routines.weekdays.length === 7 && g.routines.hours.reduce((a, b) => a + b, 0) > 0, 'routines: hour and weekday histograms');
  ok(g.reading.pages > 0 && g.reading.medianSeconds > 0 && g.reading.style === 'reads', 'reading: deep reading is recognised', g.reading);
  ok(g.categories[0].category === 'code hosting', 'categories ranked by time', g.categories);
}

console.log('\nPaused and switched off');
{
  const d = sample();
  d.paused = true;
  const p = G.buildDigest(d, NOW);
  ok(p.paused === true && p.domains.length === 0 && p.searchTerms.length === 0 && p.threads.length === 0, 'paused learning: the digest says paused and nothing else');
  const o = G.buildDigest(sample(), NOW, { useBrowsing: false });
  ok(o.off === true && o.domains.length === 0 && o.searchTerms.length === 0, '"use my browsing" off: nothing but the flag');
}

console.log('\nFiles');
{
  const dir = fs.mkdtempSync(path.join(out, 'home-'));
  const file = G.digestFile(dir);
  ok(file.endsWith(path.join('browser', 'profile-digest.json')), 'the digest lives at desktop/browser/profile-digest.json');
  ok(G.writeDigest(file, G.buildDigest(sample(), NOW)) && JSON.parse(fs.readFileSync(file, 'utf8')).v === 1 && !fs.existsSync(`${file}.tmp`), 'written atomically');
  const sw = path.join(dir, 'browser', 'about-you.json');
  ok(G.readUseBrowsing(sw) === true, 'the switch is on by default');
  G.writeUseBrowsing(sw, false);
  ok(G.readUseBrowsing(sw) === false, 'the switch round-trips');
}

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(out, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
