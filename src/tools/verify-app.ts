/**
 * Load the thing that was built, in a real browser, and report what happened.
 *
 * The gap this closes is the one that made a benchmark run worthless. Three
 * models were asked for a single-file 3D space planner. A keyword check said
 * two of them scored 12 out of 12 features. Opened in a browser, one threw on
 * load and rendered nothing at all, and the other was a shell — the toolbars
 * were there, the app was not. The harness reported both as finished work.
 *
 * Nothing in the loop had ever *run* the artifact. The agent wrote a file, read
 * it back, saw its own text, and concluded it worked. Reading your own output
 * is not evidence, and asking the model whether it succeeded is not a test.
 *
 * So: open the file, wait for it to settle, and collect what a person opening
 * it would hit —
 *
 *   **Uncaught exceptions.** The difference between a page and a blank screen.
 *   Ranked first because one of these means nothing else matters.
 *   **Console errors.** Usually the honest reason something silently does not
 *   work, and the specific thing the user asked to be resolved.
 *   **Failed requests.** A 404 on a script is invisible on the page and fatal
 *   to it — and for a brief that says "no external requests", any off-origin
 *   request is itself the finding.
 *   **What actually rendered.** Element counts, canvas sizes, whether anything
 *   was drawn. A `<canvas>` nobody draws to is the signature of a shell.
 *   **Whether the controls do anything.** Named checks click a selector and
 *   look for the DOM to change. A button that does nothing is the other half
 *   of a shell, and it cannot be seen from the source.
 *
 * The verdict is structured, not prose, because {@link ../verification.ts}
 * consumes it: a turn that produced a web artifact cannot end `completed` on a
 * page that throws. A tool the agent may ignore is a suggestion; a gate that
 * reads the verdict is a requirement.
 *
 * Uses `playwright-core` against a browser already on the machine, so this
 * costs a small dependency rather than a 300 MB download.
 *
 * @module tools/verify-app
 */

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { currentCwd } from '../run-context.js';
import { findPlaceholders, describePlaceholders, type Placeholder } from '../substance.js';

/** Per-check click-and-observe result. */
export interface FlowResult {
  name: string;
  selector: string;
  ok: boolean;
  /** Why it failed, in the terms the reader needs to fix it. */
  detail: string;
}

export interface VerifyVerdict {
  /** Whether the page loaded at all. Everything else is moot when false. */
  loaded: boolean;
  url: string;
  title: string;
  /** Errors no handler caught — the ones that stop a page dead. */
  uncaughtExceptions: string[];
  consoleErrors: string[];
  consoleWarnings: string[];
  /** Requests that failed or were refused, with the reason. */
  failedRequests: string[];
  /** Off-origin requests, listed separately: for an offline brief these are findings. */
  externalRequests: string[];
  /** What ended up on the page. */
  rendered: {
    elements: number;
    visibleText: number;
    canvases: { width: number; height: number; painted: boolean }[];
    svgs: number;
    /** Largest painted area, as a share of the viewport. Near zero means blank. */
    coverage: number;
  };
  flowsChecked: number;
  brokenFlows: FlowResult[];
  /** Work that is described rather than done. Reported, but not blocking on its own. */
  placeholders: Placeholder[];
  /** The single question the gate asks. */
  passed: boolean;
  /** Ordered worst-first, for a reader who will only read the first line. */
  problems: string[];
}

export interface VerifyAppInput {
  /** File path or URL of the artifact under test. */
  target: string;
  /** Named click-and-observe checks. */
  checks?: { name: string; selector: string; expect?: string }[];
  /** Milliseconds to let the page settle before reading it. */
  settleMs?: number;
  viewport?: { width: number; height: number };
}

/** Where a browser might already be. Checked in order; first hit wins. */
const BROWSER_CANDIDATES: { channel: string; paths: string[] }[] = [
  {
    channel: 'chrome',
    paths: [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
    ],
  },
  {
    channel: 'msedge',
    paths: [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/usr/bin/microsoft-edge',
    ],
  },
];

/** An installed browser, or nothing. Never throws — absence is a normal answer. */
export function findBrowser(): string | undefined {
  for (const candidate of BROWSER_CANDIDATES) {
    for (const p of candidate.paths) {
      try { if (fs.existsSync(p)) return p; } catch { /* unreadable path is a miss */ }
    }
  }
  return undefined;
}

/**
 * Read the page the way a person would, from inside it.
 *
 * Runs in the page rather than over the DOM protocol because the questions
 * worth asking — is this canvas actually painted, is anything visible — need
 * pixels and layout, which only exist in the page.
 */
const INSPECT = `(() => {
  const px = window.innerWidth * window.innerHeight;
  const canvases = [...document.querySelectorAll('canvas')].map(c => {
    let painted = false;
    try {
      // A canvas with no non-transparent pixel was never drawn to. Sampling a
      // grid rather than the whole buffer keeps this cheap on a large canvas.
      const ctx = c.getContext('2d');
      if (ctx) {
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const step = Math.max(4, Math.floor(d.length / 4 / 2000) * 4);
        for (let i = 3; i < d.length; i += step) { if (d[i] !== 0) { painted = true; break; } }
      } else {
        // WebGL: getImageData throws, but a live context on a sized canvas is
        // itself the evidence — nothing else can have taken it.
        painted = !!(c.getContext('webgl2') || c.getContext('webgl')) && c.width > 0 && c.height > 0;
      }
    } catch (e) { painted = c.width > 0 && c.height > 0; }
    return { width: c.width, height: c.height, painted };
  });

  // The largest thing actually drawn, as a share of the viewport. A page whose
  // biggest visible element covers a fraction of a percent is blank, whatever
  // its markup says.
  let biggest = 0;
  for (const el of document.body ? document.body.querySelectorAll('*') : []) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) continue;
    biggest = Math.max(biggest, r.width * r.height);
  }

  return {
    elements: document.querySelectorAll('*').length,
    visibleText: (document.body ? document.body.innerText || '' : '').trim().length,
    canvases,
    svgs: document.querySelectorAll('svg').length,
    coverage: px > 0 ? Math.min(1, biggest / px) : 0,
  };
})()`;

/** A stable fingerprint of the page, to tell whether a click changed anything. */
const SNAPSHOT = `(() => {
  const b = document.body;
  if (!b) return 'no-body';
  const canvasSig = [...document.querySelectorAll('canvas')].map(c => {
    try { return (c.getContext('2d')?.canvas.toDataURL().length) || c.width + 'x' + c.height; }
    catch { return c.width + 'x' + c.height; }
  }).join(',');
  return [
    b.innerHTML.length,
    document.querySelectorAll('*').length,
    (b.innerText || '').trim().slice(0, 4000),
    canvasSig,
  ].join('|');
})()`;

/**
 * Operate a control the way its type demands, and say what was done.
 *
 * Clicking is right for a button and wrong for everything that carries a value.
 * A colour input opens a native OS dialog that headless Chrome does not have,
 * so a click changes nothing and the control looks dead — this reported a
 * correctly wired brand-colour picker as broken, which is the worst failure a
 * gate can have. Working code that gets flagged sends a model off to "fix" what
 * was already right, and after one of those the check is worth less than
 * nothing.
 *
 * So a value control gets a new value and the `input` and `change` events a
 * real interaction would raise, and a button gets a click.
 */
async function drive(el: import('playwright-core').Locator): Promise<string> {
  const kind = await el.evaluate((node: Element) => {
    const tag = node.tagName.toLowerCase();
    if (tag === 'select') return 'select';
    if (tag !== 'input') return 'click';
    const type = (node as HTMLInputElement).type;
    if (type === 'color' || type === 'range' || type === 'number' || type === 'date') return type;
    if (type === 'text' || type === 'search') return 'text';
    return 'click';
  }).catch(() => 'click');

  if (kind === 'click') {
    await el.click({ timeout: 5000, force: true });
    return 'clicked';
  }

  if (kind === 'select') {
    // The second option, since the first is usually the one already chosen and
    // re-selecting it changes nothing by definition.
    const changed = await el.evaluate((node: Element) => {
      const sel = node as HTMLSelectElement;
      if (sel.options.length < 2) return false;
      sel.selectedIndex = sel.selectedIndex === 0 ? 1 : 0;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    });
    return changed ? 'changed the selection' : 'clicked';
  }

  await el.evaluate((node: Element, type: string) => {
    const field = node as HTMLInputElement;
    if (type === 'color') {
      field.value = field.value === '#00ff88' ? '#ff0055' : '#00ff88';
    } else if (type === 'range' || type === 'number') {
      const min = Number(field.min || 0);
      const max = Number(field.max || 100);
      const now = Number(field.value || min);
      field.value = String(now >= max ? min : Math.min(max, now + (Number(field.step) || 1)));
    } else if (type === 'date') {
      field.value = '2026-01-15';
    } else {
      field.value = 'aico verification';
    }
    // Both, because handlers are wired to one or the other and there is no way
    // to tell which from outside. A real interaction raises both anyway.
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }, kind);

  return kind === 'color' ? 'set a new colour'
    : kind === 'range' || kind === 'number' ? 'moved the value'
    : 'typed into it';
}

/** Trim a message to something a log can hold without losing the identifying part. */
function brief(text: string, max = 300): string {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

/**
 * Open the artifact and report what a person opening it would hit.
 *
 * Never throws for a *page* problem — a page that dies on load is the finding,
 * not an error. Throws only when the check itself could not be performed, which
 * is a different thing and must not be mistaken for a pass.
 */
export async function verifyApp(input: VerifyAppInput): Promise<VerifyVerdict> {
  const { target, checks = [], settleMs = 2500, viewport = { width: 1440, height: 900 } } = input;

  const isUrl = /^https?:\/\//i.test(target);
  let url: string;
  if (isUrl) {
    url = target;
  } else {
    const abs = path.isAbsolute(target) ? target : path.join(currentCwd(), target);
    if (!fs.existsSync(abs)) {
      throw new Error(
        `Nothing to verify: ${abs} does not exist. Build the artifact before verifying it.`,
      );
    }
    url = pathToFileURL(abs).href;
  }

  // Read before running. The two checks catch different things: the browser
  // finds what breaks, this finds what was never written — a handler whose body
  // is a comment fires happily and does nothing anyone asked for.
  const placeholders = isUrl ? [] : findPlaceholders(
    fs.readFileSync(path.isAbsolute(target) ? target : path.join(currentCwd(), target), 'utf8'),
  );

  const executablePath = findBrowser();
  if (!executablePath) {
    throw new Error(
      'VerifyApp needs a browser and found none installed (looked for Chrome and Edge in the '
      + 'usual locations). Install one, or run the check by hand — do not report the artifact '
      + 'as verified.',
    );
  }

  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath, headless: true });

  const consoleErrors: string[] = [];
  const consoleWarnings: string[] = [];
  const uncaughtExceptions: string[] = [];
  const failedRequests: string[] = [];
  const externalRequests: string[] = [];

  try {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();

    page.on('console', msg => {
      const type = msg.type();
      if (type === 'error') consoleErrors.push(brief(msg.text()));
      else if (type === 'warning') consoleWarnings.push(brief(msg.text()));
    });
    // `pageerror` is the uncaught kind. It also surfaces in the console, so it
    // is de-duplicated later rather than counted twice.
    page.on('pageerror', err => uncaughtExceptions.push(brief(err.message)));
    page.on('requestfailed', req =>
      failedRequests.push(`${req.method()} ${brief(req.url(), 120)} — ${req.failure()?.errorText ?? 'failed'}`));
    page.on('response', res => {
      if (res.status() >= 400) {
        failedRequests.push(`${res.status()} ${brief(res.url(), 120)}`);
      }
    });
    page.on('request', req => {
      const u = req.url();
      if (/^https?:\/\//i.test(u) && !(isUrl && u.startsWith(new URL(url).origin))) {
        externalRequests.push(brief(u, 120));
      }
    });

    let loaded = true;
    try {
      await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    } catch (err) {
      loaded = false;
      uncaughtExceptions.push(`navigation failed: ${brief(err instanceof Error ? err.message : String(err))}`);
    }

    // Let deferred work land. An app that builds its scene in a rAF or a timer
    // has not failed just because it was not instant, and reading the DOM the
    // millisecond load fires would call every one of them empty.
    await page.waitForTimeout(settleMs);

    const rendered = loaded
      ? await page.evaluate(INSPECT).catch(() => null) as VerifyVerdict['rendered'] | null
      : null;

    // Each check clicks and asks whether the page changed. "Nothing happened"
    // is the finding — a control that looks right and does nothing is exactly
    // what source inspection cannot catch.
    const flows: FlowResult[] = [];
    if (loaded) {
      for (const check of checks) {
        const result: FlowResult = { name: check.name, selector: check.selector, ok: false, detail: '' };
        try {
          const el = page.locator(check.selector).first();
          if (await el.count() === 0) {
            result.detail = 'no element matches this selector — the control is not on the page';
            flows.push(result);
            continue;
          }
          const before = String(await page.evaluate(SNAPSHOT));
          const errorsBefore = consoleErrors.length;
          const how = await drive(el);
          await page.waitForTimeout(600);
          const after = String(await page.evaluate(SNAPSHOT));

          if (consoleErrors.length > errorsBefore) {
            result.detail = `${how} it raised: ${consoleErrors[errorsBefore]}`;
          } else if (check.expect) {
            const hit = await page.locator(check.expect).count();
            result.ok = hit > 0;
            if (!hit) result.detail = `${how}, but nothing matched ${check.expect}`;
          } else if (before === after) {
            result.detail = `${how}, and nothing on the page changed`;
          } else {
            result.ok = true;
          }
        } catch (err) {
          result.detail = brief(err instanceof Error ? err.message : String(err), 160);
        }
        flows.push(result);
      }
    }

    const uniq = (xs: string[]) => [...new Set(xs)];
    const exceptions = uniq(uncaughtExceptions);
    // An uncaught error is also logged to the console by the browser. Reporting
    // it in both lists would double every count and make a page with one bug
    // look like a page with two.
    const errors = uniq(consoleErrors).filter(e => !exceptions.some(x => e.includes(x) || x.includes(e)));
    const broken = flows.filter(f => !f.ok);

    const view = rendered ?? { elements: 0, visibleText: 0, canvases: [], svgs: 0, coverage: 0 };
    const blankCanvases = view.canvases.filter(c => !c.painted).length;

    // Worst first. A reader who stops after one line should have read the thing
    // that matters most.
    const problems: string[] = [];
    if (!loaded) problems.push('the page did not load');
    for (const e of exceptions) problems.push(`uncaught: ${e}`);
    for (const e of errors.slice(0, 10)) problems.push(`console error: ${e}`);
    for (const f of uniq(failedRequests).slice(0, 10)) problems.push(`request failed: ${f}`);
    // Emptiness is about what rendered, not how much markup there is. An early
    // version flagged anything under ten elements and failed a working page
    // built from eight — a canvas app is *supposed* to be a short document.
    // The honest test is whether anything of any size ended up on screen.
    const blank = view.coverage < 0.02 && view.visibleText < 40
      && !view.canvases.some(c => c.painted) && view.svgs === 0;
    if (loaded && blank) {
      problems.push(`nothing rendered — the page is visually blank `
        + `(${view.elements} elements, ${view.visibleText} characters of text, nothing painted)`);
    }
    if (blankCanvases > 0) {
      problems.push(`${blankCanvases} of ${view.canvases.length} canvas element(s) were never drawn to`);
    }
    for (const f of broken) problems.push(`"${f.name}" does not work: ${f.detail}`);

    return {
      loaded,
      url,
      title: loaded ? await page.title().catch(() => '') : '',
      uncaughtExceptions: exceptions,
      consoleErrors: errors,
      consoleWarnings: uniq(consoleWarnings).slice(0, 10),
      failedRequests: uniq(failedRequests),
      externalRequests: uniq(externalRequests),
      rendered: view,
      flowsChecked: flows.length,
      brokenFlows: broken,
      placeholders,
      passed: problems.length === 0,
      problems,
    };
  } finally {
    await browser.close().catch(() => { /* the verdict matters more than a clean close */ });
  }
}

/** The verdict as the model should read it: the answer first, then the evidence. */
export function formatVerdict(v: VerifyVerdict): string {
  const lines: string[] = [];
  lines.push(v.passed
    ? `PASSED — ${v.url} loads and works.`
    : `FAILED — ${v.url} has ${v.problems.length} problem(s). This artifact is not finished.`);
  lines.push('');

  if (v.problems.length) {
    lines.push('Problems, worst first:');
    for (const p of v.problems) lines.push(`  - ${p}`);
    lines.push('');
  }

  const r = v.rendered;
  lines.push('What rendered:');
  lines.push(`  ${r.elements} elements, ${r.visibleText} characters of visible text, `
    + `${r.canvases.length} canvas, ${r.svgs} svg`);
  lines.push(`  largest visible element covers ${(r.coverage * 100).toFixed(1)}% of the viewport`);
  for (const c of r.canvases) {
    lines.push(`  canvas ${c.width}×${c.height} — ${c.painted ? 'painted' : 'NEVER DRAWN TO'}`);
  }

  if (v.flowsChecked > 0) {
    lines.push('');
    lines.push(`Interaction checks: ${v.flowsChecked - v.brokenFlows.length}/${v.flowsChecked} working`);
  }

  if (v.placeholders.length) {
    lines.push('');
    lines.push(describePlaceholders(v.placeholders) ?? '');
  }

  if (v.externalRequests.length) {
    lines.push('');
    lines.push(`External requests (${v.externalRequests.length}) — a self-contained page should make none:`);
    for (const u of v.externalRequests.slice(0, 8)) lines.push(`  - ${u}`);
  }

  if (v.consoleWarnings.length) {
    lines.push('');
    lines.push(`Warnings (not failures): ${v.consoleWarnings.length}`);
  }

  if (!v.passed) {
    lines.push('');
    lines.push('Fix these and verify again. Do not describe the work as done while this fails.');
  }
  return lines.join('\n');
}

export const verifyAppDefinition = {
  name: 'VerifyApp',
  description:
    'Open a web artifact in a real browser and report whether it actually works. '
    + 'Returns uncaught exceptions, console errors, failed and external requests, what '
    + 'rendered (including whether canvases were ever drawn to), and the result of each '
    + 'named interaction check. '
    + 'Reading your own source is not verification — use this before describing a web '
    + 'artifact as finished, and again after every fix.',
  inputSchema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        description: 'Path to the HTML file (relative to cwd is fine), or an http(s) URL.',
      },
      checks: {
        type: 'array',
        description:
          'Interaction checks. Each clicks a selector and reports whether anything happened. '
          + 'Cover the controls the user asked for — a button that renders but does nothing '
          + 'cannot be caught any other way.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'What this control is meant to do.' },
            selector: { type: 'string', description: 'CSS selector for the control to click.' },
            expect: {
              type: 'string',
              description:
                'Optional CSS selector that should match after the click. Without it, the check '
                + 'passes if the page changed at all.',
            },
          },
          required: ['name', 'selector'],
        },
      },
      settleMs: {
        type: 'number',
        description: 'How long to let the page settle before reading it (default 2500).',
      },
    },
    required: ['target'],
  },
};
