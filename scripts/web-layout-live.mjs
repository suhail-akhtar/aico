/**
 * The browser client's layout, measured at several widths.
 *
 * Written after a screenshot: the composer's toolbar had one control two lines
 * tall and six one line tall, so every neighbour was centred against a row it
 * did not belong to. Nothing in the codebase could have caught it. It is not a
 * type error, not a failed request, not a console warning — it is a CSS
 * consequence that only exists once the text has been laid out at a particular
 * width, in a real engine, with the real font.
 *
 * So this drives a real browser at five widths and *measures* rather than
 * looking: every control on a row must be the same height, nothing may overflow
 * its container sideways, and the document must never scroll horizontally. Those
 * three catch the whole family — a wrapped label, an unbounded model id, a row
 * that ran out of room — and they fail with the offending element named.
 *
 * Screenshots are written alongside so a person can disagree with the numbers.
 * They are evidence, not the assertion: a check nobody can fail is not a check.
 *
 * Run: node scripts/web-layout-live.mjs
 * Needs: a built client (npm --prefix web run build), a built server
 *        (npm run build), and Chrome or Edge installed.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const shots = path.join(repoRoot, 'dist-test', 'layout');

let passed = 0, failed = 0;
const fails = [];
function check(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; fails.push(label); console.log(`  ✗ ${label}`); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Widths worth checking, and why each one.
 *
 * Not a sweep. Each is a place the layout actually changes: a wide desktop, the
 * window in the screenshot that started this, a half-screen split, a narrow
 * split with the sidebar still open, and a tablet.
 */
const WIDTHS = [1600, 1280, 1024, 860, 700];

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

function findBrowser() {
  for (const p of BROWSERS) {
    try { if (fs.existsSync(p)) return p; } catch { /* unreadable is a miss */ }
  }
  return undefined;
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-layout-'));
fs.writeFileSync(path.join(workspace, 'README.md'), '# layout probe\n');
fs.mkdirSync(shots, { recursive: true });

let child;
let browser;

/** Start the server and read the URL it prints, token and all. */
function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [
      path.join(repoRoot, 'dist', 'index.js'),
      'serve', '--no-open', '--project', workspace,
    ], { cwd: workspace, env: { ...process.env, FORCE_COLOR: '0' } });
    child = proc;

    const timer = setTimeout(() => reject(new Error('serve never printed a URL')), 90_000);
    proc.stdout.on('data', (data) => {
      const found = data.toString().match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/);
      if (found) { clearTimeout(timer); resolve(found[0]); }
    });
    proc.on('error', reject);
  });
}

try {
  console.log('\nWEB LAYOUT — measured in a real browser\n');

  const executablePath = findBrowser();
  if (!executablePath) {
    console.log('  — no Chrome or Edge installed; nothing to measure.');
    process.exit(0);
  }

  const url = await startServer();
  check(Boolean(url), 'the server came up');

  const { chromium } = await import('playwright-core');
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: WIDTHS[0], height: 900 } });

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('textarea', { timeout: 60_000 });
  // The model and provider lists arrive over the wire and change the width of
  // two controls, so measuring before they land measures a row that never
  // existed. This is the row a person sees a second after the page opens.
  await sleep(3500);

  check(true, 'the client loaded and drew a composer');

  /*
    The sidebar is open, and that is not incidental.

    The overlap that prompted these checks only appears when something else is
    taking 280px of the window — measuring a composer that has the whole width
    to itself is measuring the easy case. This is the default state of the
    client, so it is also the honest one.
  */
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await sleep(700);

    /*
      Measured from the DOM rather than from a screenshot.

      A visual diff would flag every intentional change and could not say what
      was wrong. Heights and edges say exactly which element misbehaved, which
      is the difference between a check and an alarm.
    */
    const report = await page.evaluate(() => {
      const row = document.querySelector('[data-composer-toolbar]');
      if (!row) return { found: false };

      /*
        Every button, however deeply nested, rather than the row's children.

        The children are two grouping divs whose height is whatever their
        contents make it — measuring those would report a tidy pair of equal
        boxes while a control inside one of them was two lines tall, which is
        the exact bug this file exists to catch.
      */
      const controls = [...row.querySelectorAll('button')]
        .filter(el => el.getBoundingClientRect().width > 0);
      const box = row.getBoundingClientRect();

      const heights = controls.map(el => ({
        label: (el.textContent || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 24),
        height: Math.round(el.getBoundingClientRect().height),
      })).filter(c => c.height > 0);

      const tallest = Math.max(...heights.map(h => h.height));
      const shortest = Math.min(...heights.map(h => h.height));

      return {
        found: true,
        rowHeight: Math.round(box.height),
        heights,
        tallest,
        shortest,
        /*
          Sticking out of the row's own box — in either direction.

          Checking only the right edge was not enough, and the gap let a real
          bug through: the right-hand group is right-aligned, so when it was
          allowed to be narrower than its contents it overflowed *leftwards*
          and drew itself on top of the left group. Nothing crossed the right
          edge, every height matched, and the page did not scroll.
        */
        overflowing: controls
          .filter((el) => {
            const b = el.getBoundingClientRect();
            return b.right > box.right + 1 || b.left < box.left - 1;
          })
          .map(el => (el.textContent || el.tagName).trim().slice(0, 24)),

        /*
          And the consequence of that overflow, asserted directly.

          Two controls occupying the same pixels is the thing a reader
          actually sees, so it is worth testing for as itself rather than
          trusting that the edge checks imply it. Only pairs on the same line
          are compared — controls on two different wrapped rows share x
          ranges quite legitimately.
        */
        colliding: (() => {
          const hits = [];
          for (let i = 0; i < controls.length; i += 1) {
            for (let j = i + 1; j < controls.length; j += 1) {
              const a = controls[i].getBoundingClientRect();
              const b = controls[j].getBoundingClientRect();
              const sameLine = Math.abs(a.top - b.top) < 4;
              if (!sameLine) continue;
              if (a.right <= b.left + 1 || b.right <= a.left + 1) continue;
              hits.push(`${(controls[i].textContent || '?').trim().slice(0, 14)}`
                + ` over ${(controls[j].textContent || '?').trim().slice(0, 14)}`);
            }
          }
          return hits;
        })(),
        documentScrollsSideways: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    });

    if (!report.found) {
      check(false, `${width}px — the toolbar is not marked for measurement`);
      continue;
    }

    /*
      One height, every control. This is the assertion that would have caught
      the reported bug on the day it was written: a label that wraps makes its
      control twice as tall, and nothing else about the page changes.
    */
    const ragged = report.tallest - report.shortest;
    check(
      ragged <= 1,
      `${width}px — every control on the toolbar is the same height`
      + (ragged <= 1 ? ` (${report.tallest}px)` : ` (${report.shortest}–${report.tallest}px: `
        + `${report.heights.filter(h => h.height === report.tallest).map(h => JSON.stringify(h.label)).join(', ')})`),
    );

    check(
      report.overflowing.length === 0,
      `${width}px — nothing hangs off either end of the row`
      + (report.overflowing.length ? ` (${report.overflowing.join(', ')})` : ''),
    );

    check(
      report.colliding.length === 0,
      `${width}px — no two controls are drawn on top of each other`
      + (report.colliding.length ? ` (${report.colliding.join('; ')})` : ''),
    );

    check(
      report.documentScrollsSideways === false,
      `${width}px — the page does not scroll sideways`,
    );

    const file = path.join(shots, `composer-${width}.png`);
    const row = await page.$('[data-composer-toolbar]');
    /*
      The composer, not the row alone.

      A crop of the toolbar cannot show it sitting badly against the box above
      it, which is half of what "looks weird" means.
    */
    const composer = await page.$('[data-composer]');
    await (composer ?? row)?.screenshot({ path: file });
    console.log(`      → ${path.relative(repoRoot, file)} (row ${report.rowHeight}px)`);
  }

  /*
    ── the rest of the client, swept for the same fault ──────────────────

    The composer is where it was reported, not where it is possible. Any row of
    controls can run out of width, and the symptom is always one of two things:
    something pokes out past the right edge, or the page itself starts scrolling
    sideways and drags every column with it.

    So each screen is visited at each width and asked the same two questions.
    This is deliberately not a visual diff — a diff fails on every intended
    change and cannot say what is wrong, whereas an element's own bounding box
    names the culprit.
  */
  const SCREENS = [
    { name: 'chat', open: async () => { await page.goto(url, { waitUntil: 'domcontentloaded' }); } },
    {
      name: 'settings',
      // The deep link the VS Code panel's gear uses, so this exercises the
      // route somebody actually arrives on rather than a synthetic click.
      open: async () => {
        await page.goto(`${url}&settings=1`, { waitUntil: 'domcontentloaded' });
      },
    },
    {
      name: 'skill-bench',
      // The Skills pane with a bench open: six controls in a flex row, which
      // is exactly the shape that went wrong on the composer.
      open: async () => {
        await page.goto(`${url}&settings=skills`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('button:has-text("Measure")', { timeout: 30_000 });
        await page.click('button:has-text("Measure")');
        await page.waitForSelector('text=train /', { timeout: 30_000 });
      },
    },
  ];

  for (const screen of SCREENS) {
    await screen.open();
    await sleep(3000);

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await sleep(700);

      const spill = await page.evaluate(() => {
        const limit = window.innerWidth;
        const guilty = [];
        for (const el of document.querySelectorAll('body *')) {
          const box = el.getBoundingClientRect();
          if (box.width === 0 || box.height === 0) continue;
          if (box.right <= limit + 1) continue;
          /*
            Only the innermost offender is reported.

            An element is wide because a descendant made it wide, so every
            ancestor of the real culprit also overflows — listing them all
            buries the one line that matters under its own parents.
          */
          if ([...el.children].some(child => child.getBoundingClientRect().right > limit + 1)) {
            continue;
          }
          guilty.push({
            tag: el.tagName.toLowerCase(),
            cls: (typeof el.className === 'string' ? el.className : '').slice(0, 60),
            text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
            over: Math.round(box.right - limit),
          });
        }
        return {
          guilty: guilty.slice(0, 4),
          scrollsSideways: document.documentElement.scrollWidth > limit + 1,
          by: document.documentElement.scrollWidth - limit,
        };
      });

      check(
        spill.scrollsSideways === false,
        `${screen.name} at ${width}px — the page does not scroll sideways`
        + (spill.scrollsSideways ? ` (by ${spill.by}px)` : ''),
      );
      check(
        spill.guilty.length === 0,
        `${screen.name} at ${width}px — nothing reaches past the right edge`
        + (spill.guilty.length
          ? ` (${spill.guilty.map(g => `${g.tag}.${g.cls.split(' ')[0]} ${JSON.stringify(g.text)} +${g.over}px`).join('; ')})`
          : ''),
      );

      const file = path.join(shots, `${screen.name}-${width}.png`);
      await page.screenshot({ path: file });
    }
  }
  console.log(`      → ${path.relative(repoRoot, shots)} has a shot of every screen at every width`);
} catch (err) {
  failed += 1;
  fails.push(`threw: ${err?.message ?? err}`);
  console.log(`\n  ✗ ${err?.stack ?? err}`);
} finally {
  try { await browser?.close(); } catch { /* already gone */ }
  if (child?.pid) {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        .on('error', () => { /* already gone */ });
    } else {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }
  }
  try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* windows holds handles */ }
}

console.log(`\nWEB LAYOUT: ${passed} passed, ${failed} failed`);
if (fails.length) {
  console.log('\nFailures:');
  for (const f of fails) console.log(`  - ${f}`);
}
process.exit(failed > 0 ? 1 : 0);
