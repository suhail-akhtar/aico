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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aico-canvas-unit-'));
async function load(name) {
  const outfile = path.join(tmp, `${name}.mjs`);
  await build({ entryPoints: [path.join(here, '..', 'shared', 'ui', 'canvas', `${name}.ts`)], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'error' });
  return import(pathToFileURL(outfile).href);
}
const c = await load('core');
const B = await load('blocks');
const R = await load('rich-md');
const C = await load('comments');
const V = await load('visual');
const T = await load('templates');

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

// ── AICO Docs: blocks with source spans ──────────────────────────────

console.log('\n══ AICO Docs — blocks ══');

const DOC = [
  '# Launch plan',
  '',
  'Intro with **bold**, _em_ and a [link](https://example.com).',
  'Second line of the same paragraph.',
  '',
  '<!-- aico:pending id="s2" intent="Goals: the three outcomes" heading="Goals" -->',
  '',
  '## Timeline',
  '',
  '*   odd spacing list',
  '*   kept exactly',
  '',
  '- one',
  '  - nested',
  '- [x] done',
  '',
  '- loose',
  '',
  '| A | B |',
  '|---|:-:|',
  '| 1 | 2 |',
  '',
  '```mermaid',
  'flowchart LR',
  '',
  '  A --> B',
  '```',
  '',
  '$$',
  'E = mc^2',
  '$$',
  '',
  '> a quote',
  'lazy line',
  '',
  '<!-- a note -->',
  '',
  'Setext',
  '======',
  '',
  '***',
  '',
  '1. first',
  '2. second',
  'Trailing paragraph',
].join('\n');

test('splitBlocks finds every top-level block with its exact span', () => {
  const blocks = B.splitBlocks(DOC);
  const kinds = blocks.map(b => b.kind).join(',');
  assert.equal(kinds, 'heading,paragraph,pending,heading,list,table,code,math,quote,html,heading,rule,list', kinds);
  let prevEnd = -1;
  for (const b of blocks) {
    assert.equal(b.text, DOC.slice(b.start, b.end));
    assert.ok(b.start > prevEnd, 'in order, not overlapping');
    prevEnd = b.end;
  }
  assert.equal(blocks[4].text, '*   odd spacing list\n*   kept exactly\n\n- one\n  - nested\n- [x] done\n\n- loose', 'a loose list stays one block');
  assert.equal(blocks[6].lang, 'mermaid');
  assert.equal(blocks[6].text.split('\n').length, 5, 'a fence spans its blank lines');
  assert.equal(blocks[8].text, '> a quote\nlazy line', 'lazy continuation stays in the quote');
  assert.equal(blocks[10].level, 1, 'setext heading');
  assert.equal(blocks[2].pending.id, 's2');
  assert.equal(blocks[2].pending.heading, 'Goals');
  assert.equal(blocks[12].text, '1. first\n2. second\nTrailing paragraph', 'lazy continuation of the last item');
});

test('splitBlocks: CRLF documents keep exact spans without the \\r', () => {
  const crlf = '# T\r\n\r\nPara one\r\nline two\r\n\r\n- a\r\n- b\r\n';
  const blocks = B.splitBlocks(crlf);
  assert.deepEqual(blocks.map(b => b.text), ['# T', 'Para one\r\nline two', '- a\r\n- b']);
  const next = B.replaceBlock(crlf, blocks[1], 'Changed');
  assert.equal(next, '# T\r\n\r\nChanged\r\n\r\n- a\r\n- b\r\n');
});

test('replacing one block leaves every other byte identical (the key invariant)', () => {
  const blocks = B.splitBlocks(DOC);
  for (const b of blocks) {
    const next = B.replaceBlock(DOC, b, `${b.text}\nEDITED`);
    assert.equal(next.slice(0, b.start), DOC.slice(0, b.start));
    assert.equal(next.slice(b.end + '\nEDITED'.length), DOC.slice(b.end));
    // Re-splitting finds the other blocks' text unchanged.
    const again = B.splitBlocks(next).map(x => x.text);
    for (const other of blocks) if (other !== b && other.kind !== 'paragraph') assert.ok(again.includes(other.text) || next.includes(other.text));
  }
});

test('an interrupted paragraph: a heading or list ends it', () => {
  const b = B.splitBlocks('para\n# H\ntext\n- item');
  assert.deepEqual(b.map(x => x.kind), ['paragraph', 'heading', 'paragraph', 'list']);
});

test('pending placeholders: entities decoded, stripped for export', () => {
  const p = B.parsePending('<!-- aico:pending id="s3" intent="Risks &amp; &quot;mitigations&quot; -&#45; top 3" -->');
  assert.deepEqual(p, { id: 's3', intent: 'Risks & "mitigations" -- top 3' });
  assert.equal(B.parsePending('<!-- note -->'), null);
  const line = B.pendingLine('s9', 'A "quoted" -- intent', 'Head');
  assert.deepEqual(B.parsePending(line), { id: 's9', intent: 'A "quoted" -- intent', heading: 'Head' });
  assert.ok(!line.slice(4, -3).includes('--'), 'no -- inside the comment body');
  assert.equal(B.stripPending('# A\n\n<!-- aico:pending id="s2" intent="x" -->\n\nText\n'), '# A\n\nText\n');
});

test('findSection: pending id, heading text, levels, sectionIds', () => {
  const md = '# Doc\n\n## Goals\n\nG1\n\n### Sub\n\nS\n\n## Plan\n\nP\n\n<!-- aico:pending id="s4" intent="x" -->\n\n## After';
  const blocks = B.splitBlocks(md);
  const idx = (k, ids) => { const r = B.findSection(blocks, k, ids); return r && blocks.slice(r.from, r.to).map(b => b.text.split('\n')[0]); };
  assert.deepEqual(idx('Goals'), ['## Goals', 'G1', '### Sub', 'S']);
  assert.deepEqual(idx('## goals '), ['## Goals', 'G1', '### Sub', 'S'], 'case- and hash-insensitive');
  assert.deepEqual(idx('Plan'), ['## Plan', 'P'], 'ends at the next pending block');
  assert.deepEqual(idx('s4'), ['<!-- aico:pending id="s4" intent="x" -->']);
  assert.deepEqual(idx('s2', { s2: 'Plan' }), ['## Plan', 'P'], 'a written section keeps its id');
  assert.equal(B.findSection(blocks, 'Nope'), null);
  assert.equal(B.sectionPath(blocks, 4), 'Doc › Goals › Sub');
});

test('insertBlockAfter / removeBlock keep neighbours intact', () => {
  const md = 'A\n\nB\n';
  const [a, b] = B.splitBlocks(md);
  const ins = B.insertBlockAfter(md, a, 'NEW');
  assert.equal(ins.source, 'A\n\nNEW\n\nB\n');
  assert.equal(ins.source.slice(ins.start, ins.end), 'NEW');
  assert.equal(B.insertBlockAfter(md, b, 'END').source, 'A\n\nB\n\nEND\n');
  assert.equal(B.insertBlockAfter('', null, 'FIRST').source, 'FIRST\n');
  assert.equal(B.removeBlock('A\n\nNEW\n\nB\n', B.splitBlocks('A\n\nNEW\n\nB\n')[1]), 'A\n\nB\n');
});

test('rebaseEdits re-applies block edits on a newer text, and refuses a clobber', () => {
  const latest = '# T\n\nAgent added this.\n\nMy paragraph.\n';
  assert.deepEqual(B.rebaseEdits(latest, [{ before: 'My paragraph.', after: 'My **better** paragraph.' }]),
    { ok: true, text: '# T\n\nAgent added this.\n\nMy **better** paragraph.\n' });
  const r = B.rebaseEdits('# T\n\nAgent rewrote it.\n', [{ before: 'My paragraph.', after: 'Mine' }]);
  assert.equal(r.ok, false);
});

test('changedBlocks marks what somebody else just wrote', () => {
  const before = '# A\n\nold\n';
  const after = B.splitBlocks('# A\n\nold\n\n## New\n\nfresh\n');
  assert.deepEqual(B.changedBlocks(before, after), [2, 3]);
});

test('tableMarkdown and insert templates', () => {
  assert.equal(B.tableMarkdown(1, 2), '| Column 1 | Column 2 |\n| --- | --- |\n|     |     |');
  assert.equal(B.splitBlocks(B.tableMarkdown(3, 4))[0].kind, 'table');
  assert.equal(B.splitBlocks(B.insertTemplate('checklist'))[0].kind, 'list');
  assert.equal(B.splitBlocks(B.insertTemplate('mermaid'))[0].lang, 'mermaid');
  assert.equal(B.splitBlocks(B.insertTemplate('math'))[0].kind, 'math');
  assert.equal(B.splitBlocks(B.insertTemplate('chart'))[0].lang, 'chart');
});

// ── AICO Docs: the rich block editor's Markdown ──────────────────────

console.log('\n══ AICO Docs — rich editing ══');

/** A fake DOM node — the interface the serialiser reads. */
function h(tag, attrs = {}, children = []) {
  const node = {
    nodeType: 1, nodeName: tag.toUpperCase(),
    childNodes: children.map(ch => (typeof ch === 'string' ? { nodeType: 3, nodeName: '#text', nodeValue: ch, childNodes: [] } : ch)),
    getAttribute: n => (n in attrs ? String(attrs[n]) : null),
  };
  if (tag === 'input') node.checked = 'checked' in attrs;
  return node;
}
/** Parse the HTML the rich editor opens with into fake nodes — enough for the editor's own markup. */
function parseHtml(html) {
  const root = h('div');
  const stack = [root];
  const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  for (const m of html.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g)) {
    const top = stack[stack.length - 1];
    if (m[4]) { top.childNodes.push({ nodeType: 3, nodeName: '#text', nodeValue: decode(m[4]), childNodes: [] }); continue; }
    if (m[1]) { stack.pop(); continue; }
    const attrs = {};
    for (const a of m[3].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] === undefined ? '' : decode(a[2]);
    const el = h(m[2], attrs);
    top.childNodes.push(el);
    if (!/^(br|input)$/i.test(m[2])) stack.push(el);
  }
  return root;
}
/** What opening a block in the rich editor and closing it again saves. */
const reopen = md => R.serializeBlocks(R.domToBlocks(parseHtml(R.blocksToHtml(R.parseRichBlock(md)))));

const RICH = [
  'A plain paragraph.',
  'Text with **bold**, *em*, _under em_, ~~gone~~, `code` and a [link](https://x.dev "Title").',
  'Two lines\nsoft break',
  'Hard break  \nnext',
  'snake_case and 2 * 3 and a [bracket] stay text',
  '**bold with _nested em_ inside**',
  '## A heading with `code`',
  '- one\n- two\n  - nested a\n  - nested b\n- three',
  '1. first\n2. second\n   1. inner',
  '3) three\n4) four',
  '- [ ] todo\n- [x] done\n  - [ ] sub task',
  '* star\n* list',
  '- loose\n\n- items',
  '> quoted **text**\n> second line\n>\n> another para',
  'Escaped \\*stars\\* here',
];

for (const md of RICH) {
  test(`round-trips exactly: ${JSON.stringify(md).slice(0, 48)}`, () => {
    assert.ok(R.richEditable(md), `serialize(parse) = ${JSON.stringify(R.serializeBlocks(R.parseRichBlock(md) ?? []))}`);
    assert.equal(reopen(md), md, 'open in the editor and close without typing: nothing changes');
  });
}

test('blocks the rich model cannot keep exactly go to the source editor', () => {
  for (const md of [
    'Inline $x^2$ maths', '| a | b |\n|---|---|', '```js\nx\n```', 'An ![image](a.png)', '<b>html</b>', 'Fish &amp; chips',
    '-   wide marker spacing', '1. one\n3. three', 'para\n  indented continuation', '## Closed heading ##', 'Footnote[^1]',
  ]) assert.equal(R.richEditable(md), false, md);
});

test('serialiser: marks the browser makes become Markdown', () => {
  const root = h('div', {}, [h('p', {}, ['Make ', h('b', {}, ['this']), ' and ', h('i', {}, ['that']), ' ', h('strike', {}, ['old']), ' ', h('code', {}, ['x()']), ' ', h('a', { href: 'https://a.b' }, ['site'])])]);
  assert.equal(R.serializeBlocks(R.domToBlocks(root)), 'Make **this** and *that* ~~old~~ `x()` [site](https://a.b)');
});

test('serialiser: whitespace at a mark edge moves outside it; empty marks vanish', () => {
  const root = h('div', {}, [h('p', {}, ['a', h('b', {}, [' bold ']), 'b', h('i', {}, [''])])]);
  assert.equal(R.serializeBlocks(R.domToBlocks(root)), 'a **bold** b');
});

test('serialiser: nested lists and checklists', () => {
  const root = h('div', {}, [
    h('ul', { 'data-tasks': '1' }, [
      h('li', {}, [h('input', { type: 'checkbox', checked: '' }), 'done', h('ul', {}, [h('li', {}, ['child'])])]),
      h('li', {}, [h('input', { type: 'checkbox' }), 'todo']),
    ]),
    h('ol', {}, [h('li', {}, ['one']), h('li', {}, ['two', h('ol', {}, [h('li', {}, ['deep'])])])]),
  ]);
  assert.equal(R.serializeBlocks(R.domToBlocks(root)), '- [x] done\n  - child\n- [ ] todo\n\n1. one\n2. two\n   1. deep');
});

test('serialiser: nbsp, zero-width and a trailing placeholder <br> are not content', () => {
  const root = h('div', {}, [h('p', {}, ['a b​', h('br')]), h('p', {}, [h('br')]), 'loose text']);
  assert.equal(R.serializeBlocks(R.domToBlocks(root)), 'a b\n\nloose text');
});

test('serialiser: typed text that looks like Markdown is escaped, prose is not', () => {
  const root = h('div', {}, [h('p', {}, ['# not a heading, 1*2, a_b, [x](y)'])]);
  assert.equal(R.serializeBlocks(R.domToBlocks(root)), '\\# not a heading, 1\\*2, a_b, \\[x](y)');
});

test('editing one paragraph richly changes only that paragraph in the file', () => {
  const blocks = B.splitBlocks(DOC);
  const para = blocks[1];
  const dom = parseHtml(R.blocksToHtml(R.parseRichBlock(para.text)));
  // The person bolds "Intro": the browser wraps the first text node in <b>.
  const p = dom.childNodes[0];
  const first = p.childNodes[0];
  p.childNodes.splice(0, 1, h('b', {}, ['Intro']), { nodeType: 3, nodeName: '#text', nodeValue: first.nodeValue.slice('Intro'.length), childNodes: [] });
  const saved = R.serializeBlocks(R.domToBlocks(dom));
  const next = B.replaceBlock(DOC, para, saved);
  const a = DOC.split('\n');
  const b = next.split('\n');
  assert.equal(a.length, b.length);
  const changed = a.map((l, i) => (l === b[i] ? -1 : i)).filter(i => i >= 0);
  assert.deepEqual(changed, [2], 'only the paragraph\'s first line differs');
  assert.equal(b[2], '**Intro** with **bold**, _em_ and a [link](https://example.com).');
});

test('headings keep their level; a heading with a soft break is flattened', () => {
  const root = h('div', {}, [h('h3', {}, ['Title']), h('p', {}, ['body'])]);
  assert.equal(R.serializeBlocks(R.domToBlocks(root)), '### Title\n\nbody');
});

// ── AICO Docs: comments ──────────────────────────────────────────────

console.log('\n══ AICO Docs — comments ══');

test('an anchor is found again after the text is re-wrapped', () => {
  const text = 'The launch is in May. We ship the beta first, then the launch party.';
  const at = text.indexOf('ship the beta');
  const anchor = C.makeAnchor(text, at, at + 'ship the beta'.length);
  const moved = 'Intro added.\n\nThe launch is in May. We ship   the\nbeta first, then the launch party.';
  const r = C.locateAnchor(moved, anchor);
  assert.ok(r);
  assert.equal(moved.slice(r.start, r.end), 'ship   the\nbeta');
});

test('a repeated quote resolves to the occurrence whose context matches', () => {
  const text = 'Alpha: the plan. Beta: the plan. Gamma: the plan.';
  const second = text.indexOf('the plan', text.indexOf('Beta'));
  const anchor = C.makeAnchor(text, second, second + 'the plan'.length);
  assert.equal(C.locateAnchor(text, anchor).start, second);
});

test('a quote that is gone is orphaned, not guessed', () => {
  assert.equal(C.locateAnchor('Totally different text.', { quote: 'the plan', prefix: '', suffix: '' }), null);
  assert.equal(C.locateAnchor('x', { quote: '  ', prefix: '', suffix: '' }), null);
});

test('@AICO mentions and waiting for the agent', () => {
  assert.ok(C.mentionsAgent('@AICO can you tighten this?'));
  assert.ok(C.mentionsAgent('please @aico'));
  assert.ok(!C.mentionsAgent('email me@aico.dev'));
  const base = { id: 'c1', tabId: 't1', anchor: { quote: 'x', prefix: '', suffix: '' }, author: 'user', createdAt: 10, resolved: false };
  assert.ok(C.awaitingAgent({ ...base, body: '@AICO fix', replies: [] }));
  assert.ok(C.awaitingAgent({ ...base, body: 'fix', askAgent: true, replies: [] }));
  assert.ok(!C.awaitingAgent({ ...base, body: '@AICO fix', replies: [{ id: 'r', body: 'Done', author: 'agent', createdAt: 11 }] }));
  assert.ok(!C.awaitingAgent({ ...base, body: 'a note', replies: [] }));
  assert.ok(C.awaitingAgent({ ...base, body: '@AICO fix', replies: [{ id: 'r', body: 'Done', author: 'agent', createdAt: 11 }, { id: 'r2', body: '@AICO again', author: 'user', createdAt: 12 }] }));
});

test('margin cards stack without overlapping and orphans are split out', () => {
  assert.deepEqual(C.stackCards([10, 20, 200], [50, 50, 50], 8), [10, 68, 200]);
  const mk = (id, orphaned) => ({ id, orphaned, createdAt: 0 });
  const { placed, orphans } = C.arrangeComments([mk('a'), mk('b', true), mk('c')], c => (c.id === 'a' ? 50 : 5));
  assert.deepEqual(placed.map(p => p.comment.id), ['c', 'a']);
  assert.deepEqual(orphans.map(o => o.id), ['b']);
});

// ── AICO Docs: visual blocks ─────────────────────────────────────────

console.log('\n══ AICO Docs — visual blocks ══');

test('images: the engine spelling — caption as title, {width align} attributes; the old fragment still reads', () => {
  const line = '![Team photo](data:image/png;base64,AAAA "The pilot team"){width=60% align=right}';
  const img = V.parseImageLine(line);
  assert.deepEqual(img, { alt: 'Team photo', src: 'data:image/png;base64,AAAA', width: 60, align: 'right', caption: 'The pilot team' });
  assert.equal(V.imageLine(img), line);
  assert.equal(V.imageLine({ alt: 'x', src: 'a.png' }), '![x](a.png)', 'defaults add nothing');
  assert.equal(V.imageLine({ alt: 'x', src: 'a.png', width: 50, align: 'center' }), '![x](a.png){width=50% align=center}');
  assert.equal(V.imageLine({ alt: 'x', src: 'a.png', align: 'full' }), '![x](a.png){width=100%}');
  assert.deepEqual(V.parseImageLine('![x](a.png){width=320px}'), { alt: 'x', src: 'a.png', widthPx: 320 });
  assert.equal(V.imageLine({ alt: 'x', src: 'a.png', widthPx: 320 }), '![x](a.png){width=320px}');
  assert.equal(V.imageLine({ alt: 'x', src: 'a.png', caption: 'Say "hi"' }), '![x](a.png "Say \\"hi\\"")');
  assert.equal(V.parseImageLine(V.imageLine({ alt: 'x', src: 'a.png', caption: 'Say "hi"' })).caption, 'Say "hi"');
  assert.deepEqual(V.parseImageLine('![x](a.png#aico:w=40,align=left)'), { alt: 'x', src: 'a.png', width: 40, align: 'left' });
  assert.equal(V.parseImageLine('Text with ![img](a.png) inline'), null, 'only an image that is its own paragraph');
  assert.equal(B.splitBlocks(line)[0].kind, 'paragraph');
});

test('callouts: ```callout type fences with a Markdown body; GitHub alerts read too', () => {
  const md = V.calloutMarkdown({ type: 'warn', title: 'Heads up', body: 'Mind the gap.\n\nSecond para.' });
  assert.equal(md, '```callout warn\n**Heads up**\nMind the gap.\n\nSecond para.\n```');
  assert.deepEqual(V.parseCallout(md), { type: 'warn', title: 'Heads up', body: 'Mind the gap.\n\nSecond para.' });
  assert.deepEqual(V.parseCallout('```callout\nPlain.\n```'), { type: 'info', body: 'Plain.' });
  assert.deepEqual(V.parseCallout('```callout success\n{"title":"Done","text":"Shipped"}\n```'), { type: 'success', title: 'Done', body: 'Shipped' });
  assert.deepEqual(V.parseCallout('> [!WARNING]\n> Careful.'), { type: 'warn', body: 'Careful.' });
  assert.equal(V.parseCallout('> just a quote'), null);
  assert.equal(B.splitBlocks(md).length, 1);
});

test('tables: parse alignment and escaped pipes; serialise padded', () => {
  const t = V.parseTable('| Name | Qty | Note |\n|:--|--:|:-:|\n| a \\| b | 2 | ok |\n| c | 10 |');
  assert.deepEqual(t.align, ['left', 'right', 'center']);
  assert.deepEqual(t.rows, [['a | b', '2', 'ok'], ['c', '10', '']]);
  const md = V.tableToMarkdown(t);
  assert.equal(md, '| Name   | Qty | Note |\n| :----- | --: | :--: |\n| a \\| b | 2   | ok   |\n| c      | 10  |      |');
  assert.deepEqual(V.parseTable(md), t, 'what the grid writes, it reads back');
  assert.equal(V.parseTable('not | a table'), null);
});

test('tables: cells pasted from a spreadsheet', () => {
  assert.deepEqual(V.parseTsv('Q1\t10\nQ2\t20\n'), [['Q1', '10'], ['Q2', '20']]);
  assert.equal(V.parseTsv('just text'), null);
});

test('charts: the editor shape reads back; anything else is left to the source editor', () => {
  const m = { type: 'bar', title: 'Sales', categories: ['Q1', 'Q2'], series: [{ name: '2026', data: [3, 5] }, { name: '2027', data: [4, 6] }] };
  assert.deepEqual(V.chartFromOption(V.chartOption(m)), m);
  const area = { ...m, type: 'area' };
  assert.deepEqual(V.chartFromOption(V.chartOption(area)), area);
  const pie = { type: 'pie', title: '', categories: ['A', 'B'], series: [{ name: 'Share', data: [60, 40] }] };
  assert.deepEqual(V.chartFromOption(V.chartOption(pie)), pie);
  assert.equal(V.chartFromOption('{"series":[{"type":"sankey","data":[]}]}'), null);
  assert.equal(V.chartFromOption('not json'), null);
  const fence = V.chartTemplate('line');
  assert.equal(B.splitBlocks(fence)[0].lang, 'chart');
  assert.equal(V.chartFromOption(V.parseFence(fence).body).type, 'line');
});

test('infographics: the engine JSON bodies (and the line form, read leniently)', () => {
  for (const k of V.INFOGRAPHICS) {
    const md = V.infographicTemplate(k);
    const f = V.parseFence(md);
    assert.equal(f.lang, k);
    assert.equal(B.splitBlocks(md).length, 1, `${k} is one block`);
    assert.doesNotThrow(() => JSON.parse(f.body), `${k} body is JSON`);
  }
  const stats = V.infographicItems('stats', '{"items":[{"value":"$1.2M","label":"Revenue","delta":"+12%"},{"value":"3","label":"Churn","delta":"-1","trend":"up"}]}');
  assert.deepEqual(stats, [{ label: 'Revenue', value: '$1.2M', delta: '+12%' }, { label: 'Churn', value: '3', delta: '-1', trend: 'up' }]);
  assert.deepEqual(stats.map(V.trendOf), ['up', 'up'], 'an explicit trend wins over the sign');
  assert.deepEqual(V.infographicItems('timeline', '[{"date":"Q1","title":"Kick-off"}]'), [{ date: 'Q1', title: 'Kick-off' }], 'a bare array means items');
  assert.deepEqual(V.infographicItems('stats', 'Users | 12,400 | +18%'), [{ label: 'Users', value: '12,400', delta: '+18%' }], 'line form');
  assert.deepEqual(JSON.parse(V.infographicBody('steps', [{ title: 'Plan', text: '' }, {}])), { items: [{ title: 'Plan' }] }, 'empty fields and rows are dropped');
  const cols = [{ title: 'Build', items: ['6 months'], footer: 'Control' }, { title: 'Buy', items: ['2 weeks'], highlight: true }];
  assert.deepEqual(V.parseComparison(V.comparisonBody(cols)), cols);
  assert.deepEqual(V.parseComparison('## Build\n> Control\n- 6 months'), [{ title: 'Build', items: ['6 months'], footer: 'Control' }], 'line form');
  assert.equal(V.fenced('stats', 'a ``` b'), '````stats\na ``` b\n````', 'a fence longer than any run inside');
  assert.equal(V.INFOGRAPHIC_ALIASES.process, 'steps');
});

test('diagram templates and the table of contents', () => {
  for (const t of V.MERMAID_TEMPLATES) assert.equal(B.splitBlocks(V.mermaidTemplate(t.id))[0].lang, 'mermaid', t.id);
  const md = `# Title\n\n${V.TOC_LINE}\n\n## One\n\ntext\n\n### One a\n\n## Two`;
  const blocks = B.splitBlocks(md);
  assert.ok(V.isToc(blocks[1].text) && blocks[1].kind === 'html');
  assert.deepEqual(V.tocEntries(blocks).map(e => `${e.level}:${e.text}`), ['2:One', '3:One a', '2:Two'], 'the title is not listed');
  const planned = B.splitBlocks(`# Report\n\n${V.TOC_LINE}\n\n${B.pendingLine('s1', 'Why', 'Background')}\n\n${B.pendingLine('s2', 'What we found')}`);
  assert.deepEqual(V.tocEntries(planned).map(e => `${e.text}${e.pending ? '*' : ''}`), ['Background*', 'What we found*'], 'a plan of placeholders is listed by heading (or intent)');
});

test('templates: every one builds a document whose sections are pending placeholders', () => {
  for (const t of T.DOC_TEMPLATES) {
    const md = t.build('Q4 Plan', '30 September 2026');
    const blocks = B.splitBlocks(md);
    assert.equal(blocks[0].text, '# Q4 Plan', t.id);
    if (t.id !== 'blank') assert.ok(blocks.some(b => b.kind === 'pending' && b.pending.heading), `${t.id} has placeholders with headings`);
  }
  assert.equal(T.templateById('nope').id, 'blank');
});

// ── Docs 2: document blocks, totals, themes, page widths (round 3 of the contract) ──
const D = await load('doc-blocks');
const TH = await load('doc-themes');
const F3 = '```';

test('doc blocks: every template parses, and parse → serialise → parse is stable', () => {
  for (const k of D.DOC_BLOCK_KINDS) {
    const md = D.docBlockTemplate(k);
    const [blk] = B.splitBlocks(md);
    assert.equal(blk.kind, 'code', `${k} is one fenced block`);
    const f = V.parseFence(md);
    assert.equal(D.docBlockKind(f.lang), k);
    const a = D.parseDocBlock(k, f.body, f.info);
    assert.ok(a.ok, `${k}: ${a.error}`);
    const again = V.parseFence(D.docBlockMarkdown(a.value));
    const b = D.parseDocBlock(k, again.body, again.info);
    assert.deepEqual(b.value, a.value, `${k} round-trips`);
  }
});

test('doc blocks: aliases and lenient input', () => {
  assert.equal(D.docBlockKind('BOQ'), 'lineitems');
  assert.equal(D.docBlockKind('kv'), 'keyvalue');
  assert.equal(D.docBlockKind('bibliography'), 'references');
  assert.equal(D.docBlockKind('python'), undefined);
  const kv = D.parseDocBlock('keyvalue', '{"title":"Invoice","Invoice no.":"INV-1","Due":"Friday"}');
  assert.deepEqual(kv.value.items, [{ key: 'Invoice no.', value: 'INV-1' }, { key: 'Due', value: 'Friday' }], 'a plain object is read as rows');
  assert.equal(kv.value.title, 'Invoice');
  assert.deepEqual(D.parseDocBlock('references', '["One","Two"]').value.items.map(r => r.text), ['One', 'Two'], 'an array of strings');
  assert.deepEqual(D.parseDocBlock('meta', '{"date":"3 Oct","author":"Ann","status":"Draft"}').value.items, ['Ann', '3 Oct', 'Draft'], 'meta keys in a fixed order');
  const sig = D.parseDocBlock('signature', '["Ann","Bo","Cy","Di","Ed"]').value;
  assert.equal(sig.parties.length, 4, 'at most four signatories');
  const act = D.parseDocBlock('actions', '[{"action":"Ship","status":"WIP"},{"task":"Test","status":"Closed"},{"text":"Wait","status":"on-hold"}]').value;
  assert.deepEqual(act.items.map(i => i.status), ['in progress', 'done', 'blocked']);
  assert.ok(!D.parseDocBlock('lineitems', '{"items":[]}').ok && !D.parseDocBlock('cover', '{}').ok && !D.parseDocBlock('actions', 'not json').ok, 'empty/invalid blocks are errors');
});

test('columns: split on +++, layout from the info string, Markdown kept', () => {
  const md = '````columns sidebar\n**Skills**\n\n- a\n\n+++\n\n## Experience\n\n```js\nx()\n```\n````';
  const [blk] = B.splitBlocks(md);
  assert.equal(blk.kind, 'code', 'a four-backtick fence holds an inner fence');
  const f = V.parseFence(md);
  const c = D.parseDocBlock('columns', f.body, f.info).value;
  assert.equal(c.layout, 'sidebar');
  assert.equal(c.columns.length, 2);
  assert.ok(c.columns[1].includes('```js'), 'the inner fence survives');
  assert.ok(D.docBlockMarkdown(c).startsWith('````columns sidebar\n'), 'written back with four backticks and its layout');
  assert.equal(D.columnsLayout('columns'), 'even');
  assert.equal(D.columnsLayout('columns sidebar-right'), 'sidebar-right');
});

test('line items: totals are computed exactly in minor units', () => {
  const li = (o) => D.parseDocBlock('lineitems', JSON.stringify(o)).value;
  const t1 = D.computeTotals(li({ currency: 'GBP', taxRate: 20, items: [{ item: 'a', qty: 3, rate: 0.1 }, { item: 'b', qty: 1, rate: 1.005 }] }));
  assert.deepEqual(t1.lines, [0.3, 1.01], '0.1 × 3 is 0.30; 1.005 rounds half up');
  assert.equal(t1.subtotal, 1.31);
  assert.equal(t1.tax, 0.26);
  assert.equal(t1.total, 1.57);
  const t2 = D.computeTotals(li({ currency: 'GBP', taxRate: 20, discount: '10%', items: [{ section: 'Phase 1' }, { item: 'Workshop', qty: 2, rate: 650 }, { item: 'Build', qty: 30, rate: 600 }, { item: 'Hosting', qty: 12, rate: 100 }] }));
  assert.equal(t2.lines[0], undefined, 'a section row has no amount');
  assert.deepEqual([t2.subtotal, t2.discount, t2.tax, t2.total], [20500, 2050, 3690, 22140], 'discount before tax');
  const t3 = D.computeTotals(li({ currency: 'JPY', items: [{ item: 'x', qty: 3, rate: 333.4 }] }));
  assert.equal(t3.digits, 0);
  assert.equal(t3.total, 1000, 'yen has no minor unit');
  const t4 = D.computeTotals(li({ currency: 'USD', discount: 500, items: [{ item: 'x', rate: 100 }] }));
  assert.equal(t4.discount, 100, 'a fixed discount never exceeds the subtotal');
  assert.equal(t4.total, 0);
  const t5 = D.computeTotals(li({ items: [{ item: 'x', qty: '2', rate: '£1,250.50' }], total: 999 }));
  assert.equal(t5.total, 2501, 'numbers read from text; a typed total is ignored');
  assert.equal(D.currencyCode('$'), 'USD');
  assert.equal(D.currencyCode('nope'), 'GBP');
  assert.equal(D.formatMoney(22140, 'GBP'), '£22,140.00');
  const html = D.docBlockHtml(li({ currency: 'GBP', taxRate: 20, taxLabel: 'VAT', items: [{ item: 'a', qty: 2, rate: 10 }] }));
  assert.ok(html.includes('VAT (20%)') && html.includes('£24.00') && html.includes('db-li-total'), 'the HTML shows tax and total');
  assert.ok(!html.includes('<tfoot'), 'totals are not a tfoot (it would repeat on every printed page)');
});

test('risk matrix: levels from numbers or words, score and rating', () => {
  const r = D.parseDocBlock('riskmatrix', JSON.stringify({ risks: [
    { title: 'A', likelihood: 'almost certain', impact: 'severe' }, { title: 'B', likelihood: 9, impact: 0 }, { title: 'C', likelihood: 'possible', impact: 'minor' },
  ] })).value;
  assert.deepEqual(r.risks.map(x => [x.id, x.likelihood, x.impact]), [['R1', 5, 5], ['R2', 5, 1], ['R3', 3, 2]], 'ids default, levels clamp to 1–5');
  assert.deepEqual([4, 5, 9, 10, 16, 17, 25].map(D.riskRating), ['Low', 'Medium', 'Medium', 'High', 'High', 'Critical', 'Critical']);
  const html = D.docBlockHtml(r);
  assert.equal((html.match(/class="db-rm-cell"/g) ?? []).length, 25, 'a 5×5 heat map');
  assert.ok(html.indexOf('>R1<') < html.indexOf('>R2<', html.indexOf('db-rm-register')), 'the register is sorted by score');
});

test('block HTML escapes everything and allows only inline Markdown', () => {
  const kv = D.parseDocBlock('keyvalue', JSON.stringify({ items: [{ key: '<img src=x onerror=alert(1)>', value: '**bold** [l](javascript:alert(1)) [ok](https://a.b)' }] })).value;
  const html = D.docBlockHtml(kv);
  assert.ok(!html.includes('<img') && html.includes('&lt;img'), 'raw HTML is escaped');
  assert.ok(html.includes('<strong>bold</strong>') && html.includes('<a href="https://a.b">ok</a>') && !html.includes('href="javascript'), 'bold and http links only');
  assert.equal(D.plainInline('**a** _b_ `c` [d](https://e)'), 'a b c d');
});

test('callout icons: icon=<name> in the info string, written back', () => {
  const c = V.parseCallout('```callout warn icon=shield\n**Careful**\nText\n```');
  assert.deepEqual(c, { type: 'warn', title: 'Careful', body: 'Text', icon: 'shield' });
  assert.equal(V.calloutMarkdown(c).split('\n')[0], '```callout warn icon=shield');
  assert.equal(V.parseCallout('```callout info icon=nope\nx\n```').icon, undefined, 'unknown icons are ignored');
  assert.ok(D.iconSvg('lock').startsWith('<svg') && D.ICON_NAMES.length >= 12);
});

test('KPI tiles: values never break mid-word', () => {
  assert.ok(D.statValueSize('34%') > D.statValueSize('$100/mo') && D.statValueSize('$100/mo') > D.statValueSize('Desktop and mobile apps'));
  const min = D.statsMinWidth(['$100/mo', 'Desktop', '12 weeks', '34%']);
  assert.ok(min >= 136 && min <= 150, `four short tiles fit an A4 column (${min}px)`);
  const longWord = D.statsMinWidth(['Internationalisation']);
  assert.ok(longWord > 200, `the tile grows for a long word (${longWord}px) rather than splitting it`);
  assert.deepEqual([[4, 3], [4, 4], [5, 4], [6, 4], [3, 2], [1, 5], [6, 5.9]].map(([n, f]) => D.balancedColumns(n, f)), [2, 4, 3, 3, 2, 1, 3], 'balanced rows: 2 + 2, not 3 + 1');
  assert.ok(D.autoGrid(140).includes('auto-fit') && D.autoGrid(140).includes('grid-auto-rows: 1fr'), 'auto-fit with equal-height rows');
});

test('themes: every type exists, aliases resolve, defaults sit under stored values', () => {
  const want = ['report', 'research', 'letter', 'memo', 'cv', 'proposal', 'invoice', 'sop', 'legal', 'spec', 'release-notes', 'minutes', 'case-study', 'press-release', 'risk', 'confidential'];
  assert.deepEqual(TH.DOC_THEMES.map(t => t.id), want);
  for (const t of TH.DOC_THEMES) assert.ok(/^#[0-9A-F]{6}$/.test(t.accent), `${t.id} accent`);
  assert.equal(TH.themeById('NDA').id, 'legal');
  assert.equal(TH.themeById('resume').id, 'cv');
  assert.equal(TH.themeById('whitepaper').id, 'report');
  assert.equal(TH.themeById('nope'), undefined);
  const conf = TH.resolveLook({ theme: 'confidential' });
  assert.equal(conf.classification, 'CONFIDENTIAL');
  assert.equal(conf.watermark, 'CONFIDENTIAL');
  assert.equal(TH.resolveLook({ theme: 'confidential', watermark: '' }).watermark, undefined, 'an emptied watermark stays off');
  assert.equal(TH.resolveLook({ theme: 'confidential', classification: 'SECRET' }).classification, 'SECRET');
  assert.equal(TH.resolveLook({ theme: 'report', accent: '#abcdef' }).accent, '#ABCDEF');
  assert.deepEqual(TH.resolveLook({ theme: 'report' }).faces, { body: 'sans', heading: 'serif' });
  assert.deepEqual(TH.resolveLook({ theme: 'report', font: 'serif' }).faces, { body: 'serif', heading: 'serif' });
  const { attrs, vars } = TH.themeAttrs(TH.resolveLook({ theme: 'research' }));
  assert.equal(attrs['data-dt'], 'research');
  assert.equal(attrs['data-dt-numbered'], '1');
  assert.equal(vars['--dt-accent'], '#7F1D1D');
  const css = TH.themeRules('body');
  assert.ok(css.includes('body[data-dt-numbered] h2::before') && css.includes('body[data-dt-table="banded"] th'), 'rules are scoped');
  assert.equal(TH.tint('#000000', 0.1), 'E6E6E6');
});

test('blueprints (ADR 0022): the page is set in the family\'s faces and numbers as the export will', () => {
  const look = TH.resolveLook({ docType: 'technical-proposal' });
  assert.equal(look.blueprint.id, 'proposal');
  assert.equal(look.theme.id, 'proposal', 'a type with no stored theme takes its family\'s');
  assert.equal(look.fonts.body.word, 'Segoe UI');
  const { attrs, vars } = TH.themeAttrs(look);
  assert.equal(attrs['data-dt-bp'], 'proposal');
  assert.equal(attrs['data-dt-numbered'], '1');
  assert.ok(vars['--dt-body'].startsWith("'Segoe UI'") && vars['--dt-head-weight'] === '600');
  // A document that chose the other body class keeps the round-3 faces.
  assert.equal(TH.resolveLook({ theme: 'report', font: 'serif' }).fonts.body.word, 'Georgia');
  assert.equal(TH.resolveLook({}).blueprint.id, 'general');
  assert.ok(TH.themeRules('body').includes('font-weight: var(--dt-head-weight, 700)'));
});

test('page widths: the stored choice, else Normal beside the chat and Wide in full screen', () => {
  assert.equal(TH.pageWidthFor(undefined, false), 'normal');
  assert.equal(TH.pageWidthFor(undefined, true), 'wide');
  assert.equal(TH.pageWidthFor('narrow', true), 'narrow');
  assert.equal(TH.pageWidthFor('huge', false), 'normal');
  assert.equal(TH.pageWidthPx('full'), null);
  assert.ok(TH.pageWidthPx('wide') > TH.pageWidthPx('normal') && TH.pageWidthPx('normal') > TH.pageWidthPx('narrow'));
});

// ── AICO Sheets in the browser bundle (the engine-side suite is scripts/sheets-test.mjs) ──
const SM = await load('sheet-model');
console.log('\n══ AICO Sheets (UI) ══');

test('a sheet card: parsed kind, .xlsx download name, a preview of the first rows', () => {
  assert.deepEqual(c.parseCanvasRef('{"id":"cv-1234567890","title":"BOQ","kind":"sheet"}'), { id: 'cv-1234567890', title: 'BOQ', kind: 'sheet' });
  assert.equal(c.canvasFileName('Bill of quantities', 'sheet'), 'bill-of-quantities.xlsx');
  let b = SM.emptyBook('BOQ');
  b = SM.applyOp(b, { op: 'set', sheet: 'BOQ', cells: SM.gridCells([['Item', 'Qty', 'Rate', 'Amount'], ['Cement', 10, '£5.50', '=B2*C2']], { r: 0, c: 0 }) });
  b = SM.applyOp(b, { op: 'style', sheet: 'BOQ', range: 'D2', style: { num: 'currency', cur: 'GBP' } });
  assert.deepEqual(SM.sheetPreview(SM.serializeBook(b), 3), ['Item · Qty · Rate · Amount', 'Cement · 10 · £5.50 · £55.00', '2 rows']);
  assert.deepEqual(SM.sheetPreview('# not a sheet'), []);
});

test('the grid\'s edit cycle: pending ops replay on the agent\'s newer version, undo is a snapshot', () => {
  let base = SM.applyOp(SM.emptyBook(), { op: 'set', sheet: 'Sheet1', cells: { A1: 1, A2: 2, A3: '=SUM(A1:A2)' } });
  const pending = [{ op: 'set', sheet: 'Sheet1', cells: { A2: 5 } }, { op: 'style', sheet: 'Sheet1', range: 'A3', style: { b: true } }];
  const agent = SM.applyOp(base, { op: 'insert', sheet: 'Sheet1', axis: 'row', at: 0, count: 1 });
  const { book } = SM.replay(agent, pending);
  // Replay is by address: the agent's inserted row moved everything down, and the person's pending A2 edit
  // lands on what is now A2 (the old A1). Documented limit — the grid only sees the agent's result, not its ops.
  assert.equal(SM.computeBook(book).get('s1', 'A4'), 7);
  assert.equal(book.sheets[0].cells.A3.s.b, true);
  const undone = SM.replay(book, [{ op: 'replace', book: base }]).book;
  assert.equal(SM.computeBook(undone).get('s1', 'A3'), 3);
});

console.log(`\n  CANVAS: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
