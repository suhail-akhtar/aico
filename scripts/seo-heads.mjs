/**
 * Apply the canonical / social / structured-data head block to every doc page.
 *
 * Done as a script rather than by hand because there are seven pages and the
 * block has to be *identical apart from the per-page values* — the failure mode
 * with hand-editing is one page quietly missing a canonical, which nobody
 * notices until a duplicate-content warning appears months later.
 *
 * Idempotent: the block is delimited, so re-running replaces it rather than
 * stacking a second copy. Run it again after changing a title or description.
 *
 * Run: node scripts/seo-heads.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const docs = path.join(root, 'docs');

/**
 * Where the site actually lives.
 *
 * Canonical URLs must be absolute and must match the address Google crawls, so
 * this is the one value to change if the site moves to a custom domain.
 */
const BASE = 'https://suhail-akhtar.github.io/aico/';

const START = '<!-- seo:start -->';
const END = '<!-- seo:end -->';

/**
 * Matches either line ending, and this is not a detail.
 *
 * Six of these files are CRLF and one is LF. Written as a bare `\n`, the
 * insertion anchor matched exactly one page and silently skipped the other six
 * — the block landed on a single file, and a check that counted tags on *that*
 * file passed. A partial success is the worst result available, because it
 * looks finished.
 */
const NL = '\\r?\\n';

const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

/**
 * Decode HTML entities, then escape once for an attribute.
 *
 * Both halves are needed. The title is read *out of HTML*, so it already
 * contains `&amp;`; escaping that again produced `&amp;amp;` in the og:title,
 * which is what a social card would then display. Decode first, escape once,
 * and the result survives any number of re-runs.
 */
const decode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#3[49];/g, "'")
  .replace(/&amp;/g, '&');

const attr = (s) => decode(s)
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * One JSON-LD block, on the home page only.
 *
 * Structured data belongs on the page it describes, and seven pages each
 * claiming to be the SoftwareApplication would be seven competing claims about
 * one thing.
 */
function structuredData() {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'aico',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'macOS, Linux, Windows',
    softwareVersion: version,
    url: BASE,
    downloadUrl: 'https://github.com/suhail-akhtar/aico',
    codeRepository: 'https://github.com/suhail-akhtar/aico',
    programmingLanguage: 'TypeScript',
    license: 'https://opensource.org/licenses/MIT',
    description:
      'An open-source multi-provider AI coding agent for the terminal and a local '
      + 'web workspace. Keeps an append-only session log, verifies web work in a real '
      + 'browser, supervises background work, and runs as an MCP server.',
    author: { '@type': 'Person', name: 'Suhail Akhtar' },
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  }, null, 2);
}

const THEME_NOTE = '<!-- blocking on purpose: sets the theme before first paint -->';

const pages = fs.readdirSync(docs).filter(f => f.endsWith('.html')).sort();
let changed = 0;

for (const file of pages) {
  const full = path.join(docs, file);
  let html = fs.readFileSync(full, 'utf8');
  const before = html;

  const title = /<title>([\s\S]*?)<\/title>/.exec(html)?.[1]?.trim();
  const descRaw = /<meta name="description" content="([\s\S]*?)">/.exec(html)?.[1];
  if (!title || !descRaw) {
    console.error(`  ! ${file}: no title or description — skipped`);
    continue;
  }
  const desc = descRaw.replace(/\s+/g, ' ').trim();
  const url = BASE + (file === 'index.html' ? '' : file);
  // Match the file's own ending, so a mixed repository does not turn into a
  // diff of every line.
  const eol = html.includes('\r\n') ? '\r\n' : '\n';

  const block = [
    START,
    `<link rel="canonical" href="${url}">`,
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="aico">',
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:title" content="${attr(title)}">`,
    `<meta property="og:description" content="${attr(desc)}">`,
    `<meta property="og:image" content="${BASE}assets/og-card.png">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta property="og:image:alt" content="aico — the coding agent that opens what it builds">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${attr(title)}">`,
    `<meta name="twitter:description" content="${attr(desc)}">`,
    `<meta name="twitter:image" content="${BASE}assets/og-card.png">`,
    ...(file === 'index.html'
      ? ['<script type="application/ld+json">', structuredData(), '</script>']
      : []),
    END,
  ].join(eol);

  if (html.includes(START)) {
    html = html.replace(new RegExp(`${START}[\\s\\S]*?${END}`), () => block);
  } else {
    // Drop the ad-hoc OG tags the home page grew by hand, so the managed block
    // does not duplicate them.
    html = html.replace(
      new RegExp(`^<meta property="og:(?:title|description|type)" content="[^"]*">${NL}`, 'gm'),
      '',
    );
    html = html.replace(
      new RegExp(`(<meta name="description" content="[\\s\\S]*?">${NL})`),
      // A function replacement, so a `$&` or `$1` inside a description can never
      // be reinterpreted as a substitution pattern.
      (match) => match + block + eol,
    );
  }

  // The theme script blocks on purpose — deferring it reintroduces a
  // light-mode flash — so it is marked rather than left looking like an
  // oversight. Cleared first, so re-running cannot stack the comment.
  html = html
    .replace(/(<!-- (?:intentionally blocking|blocking on purpose)[^>]*-->)+/g, '')
    .replace('<script src="assets/site.js"></script>',
      `<script src="assets/site.js"></script>${THEME_NOTE}`);

  if (html !== before) {
    fs.writeFileSync(full, html);
    changed++;
  }
  const ok = html.includes(START) && html.includes('rel="canonical"');
  console.log(`  ${ok ? '✓' : '✗'} ${file}${ok ? '' : '  — BLOCK NOT APPLIED'}`);
  if (!ok) process.exitCode = 1;
}

// ── sitemap.xml ────────────────────────────────────────────────────────
// Submitted to Search Console, this is what gets every page crawled rather
// than only the ones the home page happens to link prominently.
const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(docs, 'sitemap.xml'), [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...pages.map(file => [
    '  <url>',
    `    <loc>${BASE}${file === 'index.html' ? '' : file}</loc>`,
    `    <lastmod>${today}</lastmod>`,
    `    <priority>${file === 'index.html' ? '1.0' : '0.8'}</priority>`,
    '  </url>',
  ].join('\n')),
  '</urlset>',
  '',
].join('\n'));
console.log('  ✓ sitemap.xml');

// ── robots.txt ─────────────────────────────────────────────────────────
// Permissive on purpose. Its only job is pointing crawlers at the sitemap;
// there is nothing on a public docs site worth hiding, and a mistakenly
// restrictive robots.txt is the classic way to become unindexable.
fs.writeFileSync(path.join(docs, 'robots.txt'),
  ['User-agent: *', 'Allow: /', '', `Sitemap: ${BASE}sitemap.xml`, ''].join('\n'));
console.log('  ✓ robots.txt');

console.log(`\n${changed} page(s) written, ${pages.length} in the sitemap.`);
