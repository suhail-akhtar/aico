/**
 * Unit tests for the canvas's pure logic (`shared/ui/canvas/core.ts`): the
 * card parser, the Markdown formatting splices the toolbar and shortcuts make,
 * list continuation, file names, previews and the "Ask AI" message.
 *
 * Bundles its own subject with esbuild, so it runs on its own:
 *   node web/test-canvas.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aico-canvas-unit-')), 'core.mjs');
await build({ entryPoints: [path.join(here, '..', 'shared', 'ui', 'canvas', 'core.ts')], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
const c = await import(pathToFileURL(out).href);

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (err) { fail++; console.log(`  ✗ ${name}\n      ${err.message.split('\n').join('\n      ')}`); }
}

/** Apply a formatting op to text where `[` `]` mark the selection. */
function fmt(marked, op) {
  const a = marked.indexOf('[');
  const b = marked.indexOf(']') - 1;
  const text = marked.replace('[', '').replace(']', '');
  const s = c.formatSplice(text, a, b, op);
  const next = c.applySplice(text, s);
  return next.slice(0, s.selStart) + '[' + next.slice(s.selStart, s.selEnd) + ']' + next.slice(s.selEnd);
}

console.log('\n══ Canvas core ══');

test('parseCanvasRef reads the card', () => {
  assert.deepEqual(c.parseCanvasRef('{"id":"cv-3f9a01bc2e","title":" Launch ","kind":"document"}'), { id: 'cv-3f9a01bc2e', title: 'Launch', kind: 'document' });
  assert.deepEqual(c.parseCanvasRef('{"id":"cv-1234567890","kind":"code","language":"Python"}'), { id: 'cv-1234567890', kind: 'code', language: 'python' });
  assert.deepEqual(c.parseCanvasRef('cv-1234567890'), { id: 'cv-1234567890' });
});
test('parseCanvasRef refuses what is not a card', () => {
  assert.throws(() => c.parseCanvasRef('{"title":"x"}'), /needs the "id"/);
  assert.throws(() => c.parseCanvasRef('{"id":"../../x"}'), /needs the "id"/);
  assert.throws(() => c.parseCanvasRef('{"id":'), /JSON/);
});

test('bold wraps, and unwraps what it wrapped', () => {
  assert.equal(fmt('say [hello] now', 'bold'), 'say **[hello]** now');
  assert.equal(fmt('say **[hello]** now', 'bold'), 'say [hello] now');
  assert.equal(fmt('say [**hello**] now', 'bold'), 'say [hello] now');
});
test('inline marks keep edge spaces outside', () => {
  assert.equal(fmt('a[ word ]b', 'italic'), 'a _[word]_ b');
});
test('an empty selection gets a placeholder, selected', () => {
  assert.equal(fmt('x []y', 'bold'), 'x **[bold text]**y');
  assert.equal(fmt('[]', 'code'), '`[code]`');
});
test('link selects the URL to type over', () => {
  assert.equal(fmt('see [docs]', 'link'), 'see [docs]([https://])');
});
test('headings replace one another and toggle off', () => {
  assert.equal(fmt('Ti[t]le', 'h2'), '[## Title]');
  assert.equal(fmt('## Ti[t]le', 'h1'), '[# Title]');
  assert.equal(fmt('## Ti[t]le', 'h2'), '[Title]');
});
test('bullets on several lines, skipping blanks, and back', () => {
  assert.equal(fmt('[one\n\ntwo]', 'bullet'), '[- one\n\n- two]');
  assert.equal(fmt('[- one\n- two]', 'bullet'), '[one\ntwo]');
});
test('numbered list numbers the lines, converting bullets', () => {
  assert.equal(fmt('[- a\n- b\n- c]', 'number'), '[1. a\n2. b\n3. c]');
  assert.equal(fmt('[1. a\n2. b]', 'number'), '[a\nb]');
});
test('checklist and quote', () => {
  assert.equal(fmt('[buy milk]', 'task'), '[- [ ] buy milk]');
  assert.equal(fmt('[said this\nand that]', 'quote'), '[> said this\n> and that]');
  assert.equal(fmt('[> said this]', 'quote'), '[said this]');
});
test('a code block fences the selection on its own lines', () => {
  assert.equal(fmt('run [npm test] now', 'codeblock'), 'run \n```\n[npm test]\n```\n now');
});
test('a table lands in its own paragraph with the first header selected', () => {
  const r = fmt('Intro[]', 'table');
  assert.ok(r.startsWith('Intro\n\n| [Column 1] | Column 2 |\n| --- | --- |'), r);
});
test('the line ops cover a selection that ends at a line break', () => {
  assert.equal(fmt('[a\n]b', 'bullet'), '[- a]\nb');
});

test('Enter continues a list, and ends it on an empty item', () => {
  const t = '- one';
  const s = c.continueList(t, t.length);
  assert.equal(c.applySplice(t, s), '- one\n- ');
  const n = '3. three';
  assert.equal(c.applySplice(n, c.continueList(n, n.length)), '3. three\n4. ');
  const task = '- [x] done';
  assert.equal(c.applySplice(task, c.continueList(task, task.length)), '- [x] done\n- [ ] ');
  const empty = 'a\n- ';
  assert.equal(c.applySplice(empty, c.continueList(empty, empty.length)), 'a\n');
  assert.equal(c.continueList('plain text', 10), null);
  assert.equal(c.continueList('- one two', 5), null, 'mid-line Enter is an ordinary break');
});

test('file names and extensions', () => {
  assert.equal(c.fileBase('Q3 plan: draft #2'), 'q3-plan-draft-2');
  assert.equal(c.fileBase('!!!'), 'canvas');
  assert.equal(c.canvasExtension('document'), 'md');
  assert.equal(c.canvasExtension('code', 'TypeScript'), 'ts');
  assert.equal(c.canvasExtension('code', 'python'), 'py');
  assert.equal(c.canvasExtension('code', 'klingon'), 'txt');
  assert.equal(c.canvasFileName('Fib', 'code', 'python'), 'fib.py');
  assert.equal(c.canvasFileName('Build', 'code', 'dockerfile'), 'Dockerfile');
  assert.equal(c.canvasFileName('Launch', 'document', undefined, 'html'), 'launch.html');
});

test('previewLines strips Markdown and skips fences and rules', () => {
  const md = '# Title\n\n---\n\nSome **bold** and _it_ and [a link](https://x).\n\n```js\nhidden()\n```\n\n- item one\n1. first';
  assert.deepEqual(c.previewLines(md, 'document', 4), ['Title', 'Some bold and it and a link.', '• item one', '1. first']);
  assert.deepEqual(c.previewLines('\n\nimport x\n\nx()\n', 'code', 5), ['import x', 'x()']);
});

test('askMessage names the canvas and quotes the selection', () => {
  assert.equal(c.askMessage({ id: 'cv-1', title: 'Email', instruction: 'make it shorter' }), 'Edit canvas cv-1 ("Email") — make it shorter');
  assert.equal(c.askMessage({ id: 'cv-1', instruction: 'fix  ', selection: '  the intro ' }), 'Edit canvas cv-1 — in the selected passage "the intro": fix');
  const long = 'a'.repeat(1000) + 'MIDDLE' + 'z'.repeat(1000);
  const m = c.askMessage({ id: 'cv-1', instruction: 'x', selection: long });
  assert.ok(m.length < long.length && m.includes(' … ') && !m.includes('MIDDLE'), 'a long selection is trimmed from the middle');
});

test('relativeTime and wordCount', () => {
  const now = Date.UTC(2026, 8, 29, 12);
  assert.equal(c.relativeTime(now - 10_000, now), 'just now');
  assert.equal(c.relativeTime(now - 5 * 60_000, now), '5 min ago');
  assert.equal(c.relativeTime(now - 3 * 3_600_000, now), '3 h ago');
  assert.equal(c.relativeTime(now - 26 * 3_600_000, now), 'yesterday');
  assert.equal(c.wordCount('Hello, world — **bold** 42 - '), 4);
});

test('standaloneHtml escapes the title and embeds the body', () => {
  const html = c.standaloneHtml('A <b> & "c"', '<p>Hi</p>');
  assert.ok(html.includes('<title>A &lt;b&gt; &amp; &quot;c&quot;</title>') && html.includes('<main>\n<p>Hi</p>\n</main>'));
});

test('quick actions exist for both kinds', () => {
  assert.ok(c.DOCUMENT_ACTIONS.some(a => a.id === 'shorter') && c.DOCUMENT_ACTIONS.some(a => a.id === 'grammar'));
  assert.ok(c.CODE_ACTIONS.some(a => a.id === 'comments') && c.CODE_ACTIONS.some(a => a.id === 'explain'));
});

console.log(`\n  CANVAS: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
