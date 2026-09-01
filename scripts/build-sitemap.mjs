/**
 * The sitemap, generated from the pages that exist.
 *
 * It used to be written by hand, which fails in two ways that are easy to miss
 * because neither breaks the file. A page added without touching it is simply
 * absent — that would have happened today. And every `lastmod` carried the same
 * hand-typed date, which is not a date so much as a claim that all eight pages
 * changed at once. Google's own wording is that it uses `lastmod` "if it's
 * consistently and verifiably accurate", so a sitemap that stamps everything
 * with today buys nothing and costs the tag's credibility.
 *
 * So: the pages come from the directory, and each date comes from **git** —
 * the last commit that touched that file. That is the closest thing to the
 * truth available without a human deciding what counts as a significant change,
 * and it is verifiable, which is the property that matters.
 *
 * ## What is deliberately not emitted
 *
 * `<priority>` and `<changefreq>`. Google states plainly that it ignores both,
 * and they were the only part of the old file that could be wrong without being
 * invalid — an 0.8 beside a 1.0 reads like a signal and is not one. The survey
 * agrees: sitemaps.org's own sitemap is `loc` + `lastmod` and nothing else, and
 * vite.dev ships `loc` alone.
 *
 * ## Validity is asserted, not assumed
 *
 * The output is re-parsed and checked against the rules that actually bite: one
 * `loc` per entry, absolute URLs on the same origin, the sitemap's own directory
 * a prefix of every URL it lists (the cross-submission rule), W3C dates, no
 * future timestamps, and the 50,000-URL / 50MB ceilings. A malformed sitemap is
 * rejected silently by crawlers, so the failure mode without this is a file that
 * looks fine and is never read.
 *
 * Run: node scripts/build-sitemap.mjs [--check]
 *   --check exits non-zero if the committed file differs from what would be
 *   generated, which is what makes this enforceable rather than advisory.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const docsDir = path.join(repoRoot, 'docs');

/** Where the site is served. The sitemap must live at or above every URL in it. */
const ORIGIN = 'https://suhail-akhtar.github.io';
const BASE = '/aico/';

/**
 * `index.html` is listed as the directory it serves.
 *
 * Both URLs work, and listing both would offer a crawler two addresses for one
 * page. The directory form is what the canonical link and the og:url already
 * say, and a sitemap that disagrees with the page's own canonical is a
 * contradiction rather than a hint.
 */
const INDEX = 'index.html';

/** Sitemap limits, from the protocol. Asserted rather than assumed. */
const MAX_URLS = 50_000;
const MAX_BYTES = 50 * 1024 * 1024;

/**
 * When this file last actually changed, per git.
 *
 * Falls back to the filesystem mtime for a page that is not committed yet —
 * true on a first run and in a shallow checkout. Never invents a date: a
 * `lastmod` nobody can verify is the thing this generator exists to avoid.
 */
function lastModified(file) {
  try {
    const out = execFileSync(
      'git', ['log', '-1', '--format=%cs', '--', file],
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(out)) return out;
  } catch {
    // Not a repo, or git is absent. The mtime is still a real date.
  }
  return new Date(fs.statSync(file).mtime).toISOString().slice(0, 10);
}

/**
 * Escape the five characters the protocol requires escaping in a data value.
 *
 * None of our URLs contain any of them today. It is here because the day one
 * does — a query string with an `&` — the failure is a sitemap that no longer
 * parses, discovered by nobody.
 */
function xmlEscape(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function build() {
  const pages = fs.readdirSync(docsDir)
    .filter(name => name.endsWith('.html'))
    .sort();

  const entries = pages.map((name) => {
    const file = path.join(docsDir, name);
    const url = name === INDEX
      ? `${ORIGIN}${BASE}`
      : `${ORIGIN}${BASE}${name}`;
    return { url, lastmod: lastModified(file), name };
  });

  // Home first, then the rest alphabetically. Order carries no weight for a
  // crawler; it is for whoever opens the file next.
  entries.sort((a, b) => (a.name === INDEX ? -1 : b.name === INDEX ? 1 : a.name.localeCompare(b.name)));

  const body = entries.map(e => [
    '  <url>',
    `    <loc>${xmlEscape(e.url)}</loc>`,
    `    <lastmod>${e.lastmod}</lastmod>`,
    '  </url>',
  ].join('\n')).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;
}

/**
 * The checks a crawler would make, made here instead.
 *
 * Deliberately not a schema validation — the XSD passes on a file that lists a
 * page which does not exist, points at another host, or claims tomorrow's date.
 * These are the rules whose violation is silent.
 */
function verify(xml) {
  const problems = [];

  const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1]);
  const mods = [...xml.matchAll(/<lastmod>([^<]*)<\/lastmod>/g)].map(m => m[1]);
  const urlCount = (xml.match(/<url>/g) ?? []).length;

  if (locs.length !== urlCount) problems.push('every <url> must have exactly one <loc>');
  if (mods.length !== urlCount) problems.push('every <url> must have exactly one <lastmod>');
  if (urlCount === 0) problems.push('no URLs at all');
  if (urlCount > MAX_URLS) problems.push(`${urlCount} URLs exceeds the 50,000 limit`);
  if (Buffer.byteLength(xml) > MAX_BYTES) problems.push('over the 50MB limit');

  const prefix = `${ORIGIN}${BASE}`;
  for (const loc of locs) {
    // The rule most often broken by hand-written sitemaps: a sitemap at
    // /aico/sitemap.xml may only list URLs under /aico/.
    if (!loc.startsWith(prefix)) problems.push(`outside the sitemap's own directory: ${loc}`);
    if (/[<>"']|&(?!amp;|lt;|gt;|quot;|apos;)/.test(loc)) problems.push(`unescaped character in ${loc}`);
  }

  /*
    Today in local time, not UTC — because that is what the dates are in.

    `git log --format=%cs` reports the committer date in the commit's own
    timezone. Comparing that against `toISOString()` compares a local date with
    a UTC one, and east of Greenwich the two differ for the first hours of every
    day: this check failed at 01:30 local on a commit made thirty minutes
    earlier, calling it "in the future".
  */
  const now = new Date();
  const today = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  for (const mod of mods) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(mod)) problems.push(`not a W3C date: ${mod}`);
    // A future date is the one lastmod error that makes a crawler distrust the
    // whole file rather than one entry.
    else if (mod > today) problems.push(`lastmod is in the future: ${mod}`);
  }

  if (new Set(locs).size !== locs.length) problems.push('the same URL is listed twice');

  // Every listed page must exist on disk, or the sitemap is advertising a 404.
  for (const loc of locs) {
    const rel = loc.slice(prefix.length);
    const file = path.join(docsDir, rel === '' ? INDEX : rel);
    if (!fs.existsSync(file)) problems.push(`listed but not in docs/: ${loc}`);
  }

  // And every page on disk must be listed, which is the failure that has no
  // symptom at all — the page simply never gets crawled.
  for (const name of fs.readdirSync(docsDir).filter(n => n.endsWith('.html'))) {
    const expected = name === INDEX ? prefix : prefix + name;
    if (!locs.includes(expected)) problems.push(`in docs/ but not listed: ${name}`);
  }

  return problems;
}

const target = path.join(docsDir, 'sitemap.xml');
const xml = build();
const problems = verify(xml);

if (problems.length) {
  console.error('sitemap: refusing to write —');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

if (process.argv.includes('--check')) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (current.replace(/\r\n/g, '\n') !== xml) {
    console.error('sitemap: docs/sitemap.xml is out of date — run `npm run sitemap`');
    process.exit(1);
  }
  console.log(`sitemap: up to date (${(xml.match(/<url>/g) ?? []).length} URLs)`);
} else {
  fs.writeFileSync(target, xml, 'utf8');
  console.log(`sitemap: wrote ${path.relative(repoRoot, target)} (${(xml.match(/<url>/g) ?? []).length} URLs)`);
}
