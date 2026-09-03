/**
 * Render every diagram type the catalogue claims, in a real browser.
 *
 * ## Why a browser and not a unit test
 *
 * Mermaid measures text to lay a diagram out, so it needs a DOM that actually
 * does layout. Under jsdom every `getBBox` returns zeroes and diagrams either
 * throw or render on top of themselves — a check that passes for the wrong
 * reason, or fails for one. The only honest answer to "does this draw" is to
 * draw it.
 *
 * ## What it is really checking
 *
 * That the catalogue does not lie. `shared/widgets/diagram-types.ts` tells the
 * model twenty-six diagram types are available and hands out a sample of each;
 * this proves the bundled mermaid draws all twenty-six. Without it the list is
 * a claim about mermaid's documentation rather than about this build, and the
 * failure mode is silent: the model writes exactly what it was told, and the
 * reader gets a wall of text with nothing reporting a problem.
 *
 * A diagram that mermaid renders *into its own error graphic* counts as a
 * failure here. It returns valid SVG and a 200-shaped success, so anything
 * checking only for "did it throw" would call it a pass.
 *
 * Run with `npm run test:diagrams`. Separate from `npm test` because it needs a
 * browser and twenty seconds; skips cleanly when no browser is installed rather
 * than failing a suite over something that is not the code's fault.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execFileSync } from 'child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const { DIAGRAM_TYPES } = await import(
  pathToFileURL(path.join(root, 'dist-test', 'diagram-types.mjs')).href
);

const { findBrowser } = await import(
  pathToFileURL(path.join(root, 'dist-test', 'test-exports.js')).href
).catch(() => ({ findBrowser: undefined }));

const browserPath = findBrowser?.();
if (!browserPath) {
  console.log('\n  DIAGRAMS: skipped — no Chrome or Edge found.\n');
  process.exit(0);
}

// Inside the repo, not the system temp directory. esbuild resolves `mermaid`
// by walking up from the entry file, and from anywhere outside the tree that
// walk never reaches this project's node_modules.
const work = fs.mkdtempSync(path.join(root, 'dist-test', 'diagrams-'));
try {
  // Bundled from the repo so mermaid resolves, and so what is exercised is the
  // version in package.json rather than whatever a CDN serves today.
  const entry = path.join(work, 'entry.mjs');
  fs.writeFileSync(entry, [
    "import mermaid from 'mermaid';",
    "mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base' });",
    'window.renderOne = async (id, code) => {',
    '  const { svg } = await mermaid.render("m-" + id, code);',
    '  return svg;',
    '};',
  ].join('\n'));

  execFileSync('npx', [
    'esbuild', entry, '--bundle', '--format=esm',
    `--outfile=${path.join(work, 'bundle.js')}`, '--log-level=error',
  ], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });

  // Inlined rather than referenced. Chrome refuses to fetch an ES module over
  // `file://` — the CORS check treats it as a cross-origin request — so a
  // `<script type="module" src="…">` silently never runs and the page just
  // sits there. Escaping the closing tag matters: the bundle is a megabyte of
  // minified JavaScript and any literal `</script>` inside it would end the
  // block early.
  const bundle = fs.readFileSync(path.join(work, 'bundle.js'), 'utf8')
    .replace(/<\/script>/gi, '<\\/script>');
  fs.writeFileSync(path.join(work, 'index.html'),
    `<!doctype html><meta charset="utf-8"><body><script type="module">${bundle}</script></body>`);

  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: browserPath, headless: true });
  let pass = 0;
  const failures = [];

  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(path.join(work, 'index.html')).href);
    await page.waitForFunction('typeof window.renderOne === "function"', null, { timeout: 30_000 });

    // The sample the model is shown, plus any shapes a past failure taught us
    // to keep checking. Flattened so one bad variant fails the type it belongs
    // to rather than being reported as a diagram of its own.
    const cases = DIAGRAM_TYPES.flatMap(type => [
      { type, code: type.sample, variant: 0 },
      ...(type.alsoRenders ?? []).map((code, i) => ({ type, code, variant: i + 1 })),
    ]);

    for (const { type, code: sample, variant } of cases) {
      const outcome = await page.evaluate(async ([id, code]) => {
        try {
          const svg = await window.renderOne(id, code);
          // Mermaid answers a syntax error with a picture of a syntax error.
          // That is still an SVG and still a resolved promise, so a check that
          // only catches throws would score it as working.
          if (/aria-roledescription="error"|Syntax error/i.test(svg)) {
            return { ok: false, why: 'rendered mermaid\'s own error graphic' };
          }
          if (!svg.includes('<svg')) return { ok: false, why: 'produced no SVG' };
          return { ok: true };
        } catch (err) {
          return { ok: false, why: String(err && err.message ? err.message : err).split('\n')[0] };
        }
      }, [`${type.id}-${variant}`, sample]);

      const name = variant === 0 ? type.syntax : `${type.syntax} (variant ${variant})`;
      if (outcome.ok) {
        pass++;
        console.log(`  ok    ${name}${variant === 0 ? ` — ${type.label}` : ''}`);
      } else {
        failures.push(`${name}: ${outcome.why}`);
        console.log(`  FAIL  ${name} — ${outcome.why}`);
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\n  DIAGRAMS: ${pass} passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    console.error('The catalogue promises diagrams this build cannot draw:');
    for (const f of failures) console.error(`  - ${f}`);
    console.error('Either fix the sample or remove the type — a documented diagram with no\n'
      + 'working renderer is a wall of text in the transcript and nothing reports it.');
    process.exit(1);
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
