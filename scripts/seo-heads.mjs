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
 * Proves ownership to Google Search Console. Home page only — that is where the
 * HTML-tag method looks for a URL-prefix property.
 */
const GOOGLE_VERIFICATION = 'gpRc3scUpPI39z-lj7Nzrw1MfbZGQKTOK8gErO6jtxQ';

/**
 * The title and description for every page, owned here.
 *
 * Kept in one place because the social block below mirrors them, and two copies
 * of a sentence drift. They are written to be *read* first and to carry the
 * terms people search second — a title stuffed with keywords loses the click it
 * was optimised to win, which is the only thing a title is for.
 *
 * The terms are chosen from what this project can plausibly rank for. Head
 * terms like "best AI coding assistant" belong to third-party listicles and to
 * projects with a hundred thousand users; chasing them here would be effort
 * spent losing. What is winnable is the long tail where the differences
 * actually live: bring-your-own-key, self-hosted, terminal, MCP server, session
 * resume, spend limits.
 */
const META = {
  'index.html': {
    title: 'aico — open-source AI coding agent for the terminal and browser',
    description:
      'A free, self-hosted AI coding agent. Bring your own key for Claude, GPT, Gemini, '
      + 'DeepSeek or a local Ollama model. Append-only session log, in-browser verification '
      + 'of what it builds, and supervision for background work.',
  },
  'install.html': {
    title: 'Install aico — AI coding agent for macOS, Linux and Windows',
    description:
      'Install the aico AI coding agent with one npx command — no account, nothing global. '
      + 'Requires Node 22.5 or newer. Add a provider key and start in five minutes.',
  },
  'providers.html': {
    title: 'Bring your own API key — Claude, GPT, Gemini, Ollama | aico',
    description:
      'Run the aico coding agent on OpenAI, Anthropic, OpenRouter, Google Gemini, Z.AI GLM, '
      + 'DeepSeek, any OpenAI-compatible endpoint, or a local Ollama model. BYOK, prompt '
      + 'caching, and spending limits you set.',
  },
  'workspace.html': {
    title: 'A local web workspace for your AI coding agent — aico',
    description:
      'aico serve runs a loopback server and a browser client, and the server owns the run — '
      + 'close the tab and the work carries on. Plan mode, mid-run steering, forking a '
      + 'conversation, and a session log you can resume.',
  },
  'automation.html': {
    title: 'Background AI agents, watchers and scheduled jobs — aico',
    description:
      'One ledger for every running agent, dev server, scheduled job and watcher, surviving '
      + 'a restart. Spend and idle limits the platform enforces, and an MCP server so '
      + 'another AI can delegate work to aico.',
  },
  'compare.html': {
    title: 'aico vs Claude Code, OpenCode, Aider and Cline — compared',
    description:
      'An honest comparison of the aico AI coding agent with Claude Code, OpenCode, Aider, '
      + 'Cline and Cursor — what is genuinely different, and where the alternatives are '
      + 'clearly ahead.',
  },
  'widgets.html': {
    title: 'Charts, diagrams and maths in AI agent answers — aico',
    description:
      'The aico coding agent renders ECharts, Vega-Lite dashboards, KaTeX maths and 26 kinds '
      + 'of Mermaid diagram directly in the transcript — with a repair step when one will '
      + 'not parse.',
  },
  'miniapps.html': {
    title: 'Mini Apps — SQLite-backed apps your AI coding agent builds',
    description:
      'Ask the aico agent for an invoice ledger and get a real single-page app with a SQLite '
      + 'database behind it, at its own local URL. Two kinds: a static page, or a full '
      + 'Next.js application.',
  },
};

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

/**
 * Build FAQPage data from the page's own visible FAQ.
 *
 * Derived rather than hand-written, for two reasons. Google requires the marked-up
 * answer to match what a visitor actually reads, and a hand-kept copy would drift
 * from the prose the first time either was edited — leaving a schema block that
 * quietly asserts something the page no longer says.
 *
 * Returns nothing when the page has no FAQ, so the tag is absent rather than empty.
 */
function faqData(html) {
  const section = /<section class="faq">([\s\S]*?)<\/section>/.exec(html)?.[1];
  if (!section) return undefined;

  const entries = [];
  const re = /<h3>([\s\S]*?)<\/h3>\s*<div class="a">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(section)) !== null) {
    const question = decode(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    // Links are stripped for the schema — it wants the answer as text, and a
    // half-tagged fragment is worse than a clean sentence.
    const answer = decode(m[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (question && answer) {
      entries.push({
        '@type': 'Question',
        name: question,
        acceptedAnswer: { '@type': 'Answer', text: answer },
      });
    }
  }
  if (!entries.length) return undefined;
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: entries,
  }, null, 2);
}

const THEME_NOTE = '<!-- blocking on purpose: sets the theme before first paint -->';

const pages = fs.readdirSync(docs).filter(f => f.endsWith('.html')).sort();
let changed = 0;

for (const file of pages) {
  const full = path.join(docs, file);
  let html = fs.readFileSync(full, 'utf8');
  const before = html;

  const meta = META[file];
  if (!meta) {
    console.error(`  ! ${file}: no entry in META — add one, or it ships unoptimised`);
    process.exitCode = 1;
    continue;
  }
  const { title } = meta;
  const desc = meta.description.replace(/\s+/g, ' ').trim();

  // The page's own tags are rewritten from META too, so the title a searcher
  // sees and the og:title a social card shows cannot disagree.
  html = html.replace(/<title>[\s\S]*?<\/title>/, () => `<title>${attr(title)}</title>`);
  html = html.replace(
    /<meta name="description" content="[\s\S]*?">/,
    () => `<meta name="description" content="${attr(desc)}">`,
  );
  const url = BASE + (file === 'index.html' ? '' : file);
  // Read before the block is written, so it reflects the prose as it stands.
  const faq = faqData(html);
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
      ? [
        `<meta name="google-site-verification" content="${GOOGLE_VERIFICATION}">`,
        '<script type="application/ld+json">', structuredData(), '</script>',
      ]
      : []),
    ...(faq ? ['<script type="application/ld+json">', faq, '</script>'] : []),
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
