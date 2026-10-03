/**
 * Document design (ADR 0022), tested offline: the per-family blueprints and
 * the writing brief they drive, the layout algorithms (content-based column
 * widths, table variants, typed heading numbers, outline labels, captions),
 * the export plan, and the .docx the plan produces — every XML part parsed
 * by a real XML parser, the styles, outline numbering, sections, captions,
 * running header/footer and document properties checked — plus the HTML/PDF
 * twin (captions, fitted tables, front matter) and, when a browser is
 * installed, the TOC's page numbers read back from a printed PDF.
 *
 * Why a script of its own: the owner's 55-page proposal export failed on
 * layout, not on content — no Heading 1, typed section numbers, equal column
 * widths, a TOC of "1"s — and each of those is a rule a regression would
 * silently break. Part of `npm test`. No model, no network.
 */

// A store of this process's own — nothing below may touch ~/.aico. Must stay first.
import './lib/test-home.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';

import {
  DOC_TYPES, docTypeById, writingNote, DocBlueprints as BP, DocLayout as L, planDocument, frontModel, parseMarkdown, collectHeadings,
  resolveSettings, mergeSettings, cleanSettings, controlValues, expandRunning, createCanvas, exportCanvas, workspaceImages,
  launchExportBrowser,
} from '../dist-test/test-exports.js';

let pass = 0; let fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 900)}` : ''}`); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ── Blueprints ───────────────────────────────────────────────────────
console.log('\n══ Blueprints ══');
{
  const families = BP.BLUEPRINTS.filter(b => b.id !== 'general');
  const owners = new Map();
  for (const b of families) for (const t of b.types) owners.set(t, [...(owners.get(t) ?? []), b.id]);
  const unowned = DOC_TYPES.filter(t => (owners.get(t.id) ?? []).length !== 1).map(t => t.id);
  ok(families.length >= 8 && unowned.length === 0, `every one of the ${DOC_TYPES.length} document types belongs to exactly one of ${families.length} families`, unowned);
  const strays = [...owners.keys()].filter(id => !docTypeById(id));
  ok(strays.length === 0, 'every type a blueprint names exists', strays);
  const shapes = new Set(families.map(b => `${b.cover}/${b.numbering}/${b.fonts?.heading.word}/${b.fonts?.body.word}/${b.front.control}`));
  ok(shapes.size === families.length, 'no two families share the same cover, numbering, faces and front matter', [...shapes]);
  ok(BP.resolveBlueprint({ docType: 'technical-proposal' }).id === 'proposal' && BP.resolveBlueprint({ docType: 'architecture-design' }).id === 'technical'
    && BP.resolveBlueprint({ theme: 'sop' }).id === 'policy' && BP.resolveBlueprint({ theme: 'proposal', blueprint: 'report' }).id === 'report'
    && BP.resolveBlueprint({}).id === 'general', 'resolveBlueprint: explicit, then the type, then the theme, then general');
  const tp = docTypeById('technical-proposal');
  ok(tp.docSettings.docType === 'technical-proposal' && cleanSettings({ docType: 'technical-proposal' }).docType === 'technical-proposal',
    'a type stores its own id in its settings (it survives cleaning)');
  const brief = writingNote(tp);
  ok(/never type numbers into a heading/.test(brief) && /gantt/.test(brief) && /RACI/.test(brief) && /```lineitems/.test(brief)
    && brief.includes(BP.CAPTION_RULE) && /words in total/.test(brief), 'the technical-proposal brief carries the family: numbering rule, Gantt, RACI, pricing, captions');
  const arch = writingNote(docTypeById('architecture-design'));
  ok(/flowchart TB/.test(arch) && /topology/.test(arch) && /sequenceDiagram/.test(arch) && /dozen nodes/.test(arch),
    'the technical-design brief asks for logical architecture, topology and sequence diagrams of a readable size');
  const letter = writingNote(docTypeById('letter'));
  ok(!letter.includes(BP.CAPTION_RULE) && /No cover, no contents, no numbering/.test(letter), 'a letter is not briefed like a proposal');
  ok(tp.sections.filter(s => s.visuals?.includes('mermaid')).length >= 3, 'technical proposal: architecture, topology and Gantt sections each expect a diagram');
}

// ── Layout algorithms ───────────────────────────────────────────────
console.log('\n══ Layout algorithms ══');
{
  const reqs = [['ID', 'Requirement', 'Delivered by'], ['FR-01', 'Team and project collaboration sites with document libraries and versioning', '§3.2'],
    ['FR-02', 'Enterprise search across all content, with security trimming', '§3.3']];
  const w = L.columnWidths(reqs, { capacity: 100 });
  ok(near(w.reduce((a, x) => a + x, 0), 1) && w[1] > w[0] * 3 && w[1] > w[2] * 3, 'column widths: the prose column gets the room, ID and reference columns stay narrow', w);
  const inv = [['Server', 'Role', 'Site', 'Qty', 'RAM (GB)', 'Notes'], ['OOS-01/02', 'Office Online Server', 'DC1', '2', '1,264', 'Document rendering and co-authoring in the browser']];
  const iw = L.columnWidths(inv, { capacity: 100 });
  const units = (s) => L.textUnits(s);
  ok(iw[3] * 100 >= units('Qty') * 1.1 && iw[4] * 100 >= units('1,264') && iw[1] * 100 >= units('Online'),
    'column widths: no column is narrower than its longest word (a header word never splits, a number never wraps)', iw);
  ok(L.textUnits('NFR-01') > L.textUnits('nfr-01') && L.textUnits('ill') < 3, 'text units: capitals and digits are wider than lowercase, i and l narrower');
  const matrix = [['Activity', 'IT', 'Business', 'Supplier'], ['Design', 'A', 'C', 'R'], ['Build', 'A', 'I', 'R']];
  ok(L.tableVariant(matrix) === 'matrix' && L.tableVariant([['Element', 'Design'], ['tempdb', '12 equally sized files, pre-sized to 100 GB total']]) === 'keyvalue'
    && L.tableVariant(reqs) === 'grid', 'table variants: RACI matrix, key-value specification, data grid');
  const mw = L.columnWidths(matrix, { capacity: 100, variant: 'matrix' });
  ok(near(mw[1], mw[2]) && near(mw[2], mw[3]) && near(mw.reduce((a, x) => a + x, 0), 1), 'a matrix shares the mark columns evenly', mw);
  ok(L.numericColumns([['Item', 'Tickets', 'Share'], ['A', '12,400', '30%'], ['B', '£8,300', '20%']]).join() === 'false,true,true', 'numeric columns: counts, money and percentages');
  ok(L.isTotalRow(['**Total**', '1']) && L.isTotalRow(['Grand total']) && !L.isTotalRow(['Totally new']), 'a closing Total row is recognised');
  const a = L.apportion([0.123, 0.456, 0.421], 9638);
  ok(a.reduce((x, y) => x + y, 0) === 9638 && a.every(Number.isInteger), 'apportion: integer twips that add up exactly to the text width', a);
  ok(L.stripHeadingNumber('2.4 Non-functional requirements') === 'Non-functional requirements' && L.stripHeadingNumber('1. Executive Summary') === 'Executive Summary'
    && L.stripHeadingNumber('3 Pillars of Growth') === '3 Pillars of Growth' && L.stripHeadingNumber('2026 Roadmap') === '2026 Roadmap'
    && L.stripHeadingNumber('1.') === '1.', 'typed numbers: "2.4 …" and "1. …" are removed; "3 Pillars" and "2026 Roadmap" are titles');
  ok(L.appendixHeading('Appendix A — Glossary')?.letter === 'A' && L.appendixHeading('Annex 2: Data')?.letter === 'B' && !L.appendixHeading('Appendices are optional'),
    'appendix headings are lettered (Annex 2 is B)');
  ok(L.typedNumbering(['1. Summary', '2. Scope', '3. Plan']) && !L.typedNumbering(['Summary', '2. Scope', 'Plan']), 'hand-numbered documents are recognised');
  const slots = [{ level: 1 }, { level: 2 }, { level: 2 }, { level: 3 }, { level: 1 }, { level: 1, appendix: 'A' }, { level: 2 }, { level: 1, unnumbered: true }, { level: 2 }];
  ok(L.headingLabels(slots, 'decimal').join('|') === '1|1.1|1.2|1.2.1|2|Appendix A|A.1||', 'outline labels, decimal: 1 · 1.1 · 1.2.1, appendix A.1, an unnumbered section and its children');
  ok(L.headingLabels([{ level: 1 }, { level: 2 }, { level: 3 }, { level: 3 }], 'legal').join('|') === '1.|1.1|(a)|(b)', 'outline labels, legal: 1. · 1.1 · (a)');
}

// ── Settings ─────────────────────────────────────────────────────────
console.log('\n══ Settings ══');
{
  const c = cleanSettings({ control: { client: 'XYZ', version: '1.0', bogus: 1, revisions: [{ version: '0.1', author: 'A' }, { nope: 1 }], approvals: [{ role: 'Sponsor' }] } });
  ok(c.control.client === 'XYZ' && !('bogus' in c.control) && c.control.revisions.length === 1 && c.control.approvals[0].role === 'Sponsor', 'control is whitelisted row by row');
  const m = mergeSettings({ control: { client: 'XYZ', version: '1.0' } }, { control: { status: 'Final' } });
  ok(m.control.client === 'XYZ' && m.control.status === 'Final', 'control merges field by field (setting the status keeps the client)');
  ok(JSON.stringify(cleanSettings({ cover: false }).cover) === '{"enabled":false}', 'cover: false is kept, so it can switch off a family cover');
  const s = resolveSettings({ docType: 'architecture-design' });
  ok(s.theme === 'spec' && s.toc === true && s.cover?.enabled === true && s.margins.left === 20, 'a type with no theme stored gets its family theme, contents, cover and margins');
  ok(resolveSettings({ docType: 'architecture-design', cover: { enabled: false } }).cover.enabled === false, 'the document\'s own choice beats the family default');
  const v = controlValues(resolveSettings({ classification: 'INTERNAL' }));
  ok(v.version === '0.1' && v.status === 'Draft' && v.classification === 'INTERNAL', 'a draft says so: version 0.1, status Draft');
  ok(expandRunning('{classification} · Version {version}', { title: 'T', date: 'd', ...controlValues(resolveSettings({})) }) === 'Version 0.1'
    && expandRunning('{reference} · Page {page} of {pages}', { title: 'T', date: 'd', reference: 'R-1' }) === 'R-1 · Page {page} of {pages}',
  'running text drops segments whose fields are empty');
}

// ── The plan ─────────────────────────────────────────────────────────
console.log('\n══ The export plan ══');
const PROPOSAL = [
  '<!-- aico:toc -->', '', '## 1. Executive Summary', '', 'XYZ needs a new farm. '.repeat(60), '', '### 1.1 Why now', '', 'Support ends. '.repeat(40), '',
  '## 2. Requirements', '', 'Table: Functional requirements', '', '| ID | Requirement | Delivered by |', '|---|---|---|',
  '| FR-01 | Team and project collaboration sites with document libraries and versioning | §3.2 |', '| FR-02 | Enterprise search across all content | §3.3 |', '',
  '## 3. Architecture', '', '```mermaid', 'flowchart TB', '  A["Users"] --> B["Front end"]', '```', '', 'Figure: Logical architecture', '',
  '| Server | Qty | RAM (GB) |', '|---|---|---|', '| WFE-01 | 2 | 32 |', '| SQL-01 | 2 | 256 |', '| **Total** | **4** | **288** |', '',
  '## 4. Plan', '', 'Delivery in phases. '.repeat(30), '', '## 5. Responsibilities', '', 'Table: RACI', '',
  '| Activity | XYZ IT | Supplier |', '|---|---|---|', '| Design | A | R |', '| Build | C | R |', '', '## Appendix A — Glossary', '', '### Terms', '', 'MinRole: a server role.',
].join('\n');
{
  const tree = parseMarkdown(PROPOSAL);
  const settings = resolveSettings(mergeSettings(docTypeById('technical-proposal').docSettings, { control: { client: 'XYZ Corporation' } }));
  const plan = planDocument(tree, { title: 'Farm proposal', settings, stored: docTypeById('technical-proposal').docSettings, headings: collectHeadings(tree) });
  const h = plan.headings.map(x => `${x.level}:${x.label ?? '-'}:${x.text}`);
  ok(h.join('|') === '1:1:Executive Summary|2:1.1:Why now|1:2:Requirements|1:3:Architecture|1:4:Plan|1:5:Responsibilities|1:Appendix A:Glossary|2:A.1:Terms',
    'the plan: ## is level 1, typed numbers replaced by the outline, the appendix lettered', h);
  const caps = [...plan.captions.values()].map(c => `${c.kind} ${c.n} ${c.text}`);
  ok(caps.join('|') === 'table 1 Functional requirements|figure 1 Logical architecture|table 2 RACI' && plan.consumed.size === 3,
    'captions: "Table:" above a table and "Figure:" below a diagram become numbered captions, printed once', caps);
  const vars = [...plan.tables.values()].map(t => `${t.variant}${t.total ? '+total' : ''}`);
  ok(vars.join() === 'grid,grid+total,matrix', 'tables: a data grid, an inventory with a total row, a RACI matrix', vars);
  ok(plan.blueprint.id === 'proposal' && plan.coverPage && plan.control === 'page' && plan.tocFront && plan.numbering === 'decimal',
    'a proposal gets a cover page, a document-control page and contents in its front matter');
  const f = frontModel(plan, settings, 'Farm proposal', '3 October 2026');
  ok(f.kicker === 'TECHNICAL PROPOSAL' && f.info.some(([k, v]) => k === 'Client' && v === 'XYZ Corporation') && f.revisions[0][3] === 'Initial draft'
    && f.approvals.length === 3 && f.approvals.every(r => r[0] === ''), 'front matter: kicker from the type, document information, a first revision, approval rows left to sign');
  const short = parseMarkdown('## Flow\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n## Steps\n\nOne step.');
  const sp = planDocument(short, { title: 'A flow', settings: resolveSettings({ docType: 'flow-diagram' }), headings: collectHeadings(short) });
  ok(!sp.coverPage && sp.control === 'none' && !sp.tocFront, 'a one-page flow diagram gets no cover, control page or contents (ceremony, not design)');
  const titled = parseMarkdown('# Farm proposal\n\n## Scope\n\nx');
  const tp2 = planDocument(titled, { title: 'Farm proposal', settings: resolveSettings({}), headings: collectHeadings(titled) });
  ok(tp2.headings[0].isTitle && tp2.headings[1].level === 1, 'an opening H1 that repeats the title is the title; the sections under it are level 1');
}

// ── The .docx ────────────────────────────────────────────────────────
console.log('\n══ The .docx ══');
const project = fs.mkdtempSync(path.join(process.env.AICO_HOME, 'doc-design-'));
const ctx = { cwd: project, sessionId: 'doc-design-test' };
const imgs = workspaceImages(project);
const probe = await launchExportBrowser(20_000);
const haveBrowser = !('error' in probe);
if (haveBrowser) await probe.close();
{
  const doc = await createCanvas(ctx, { title: 'SharePoint SE — Technical Proposal', content: PROPOSAL, author: 'agent',
    docSettings: mergeSettings(docTypeById('technical-proposal').docSettings, { control: { client: 'XYZ Corporation', reference: 'XYZ-14', version: '1.0' }, classification: 'INTERNAL' }) });
  const out = await exportCanvas(doc, { format: 'docx', resolveImage: imgs, date: new Date('2026-10-03T10:00:00Z') });
  const zip = unzipSync(new Uint8Array(out.bytes));
  const errors = [];
  for (const [name, bytes] of Object.entries(zip)) {
    if (!/\.(xml|rels)$/.test(name)) continue;
    new DOMParser({ onError: (level, msg) => { if (level !== 'warning') errors.push(`${name}: ${msg}`); } }).parseFromString(strFromU8(bytes), 'text/xml');
  }
  ok(errors.length === 0, `every XML part of the package parses (${Object.keys(zip).filter(n => /\.(xml|rels)$/.test(n)).length} parts)`, errors.slice(0, 4));
  const x = strFromU8(zip['word/document.xml']);
  const st = strFromU8(zip['word/styles.xml']);
  const nb = strFromU8(zip['word/numbering.xml']);
  ok(/styleId="Heading1">.*?<w:keepNext\/>.*?<w:numPr><w:numId w:val="900"\/><\/w:numPr>.*?<w:outlineLvl w:val="0"\/>/.test(st)
    && /styleId="Heading2">.*?<w:numPr><w:ilvl w:val="1"\/><w:numId w:val="900"\/><\/w:numPr>.*?<w:outlineLvl w:val="1"\/>/.test(st)
    && ['Title', 'Subtitle', 'TOC1', 'TOC2', 'TOC3', 'Caption', 'AppendixHeading', 'TOCHeading', 'Header', 'Footer'].every(id => st.includes(`w:styleId="${id}"`)),
  'styles: Heading 1–2 keep with next, carry outline levels and the outline list; Title, TOC 1–3, Caption, Appendix and header styles exist');
  ok(/<w:abstractNum w:abstractNumId="10"><w:multiLevelType w:val="multilevel"\/>.*<w:pStyle w:val="Heading4"\/><w:lvlText w:val="%1\.%2\.%3\.%4"\/>/.test(nb)
    && /<w:pStyle w:val="AppendixHeading"\/><w:suff w:val="space"\/><w:lvlText w:val="Appendix %1 —"\/>/.test(nb) && /<w:num w:numId="900">/.test(nb),
  'numbering: a multilevel outline list tied to Heading 1–4, and the appendix list');
  ok(!/>1\. Executive Summary</.test(x) && />Executive Summary</.test(x) && /<w:pStyle w:val="AppendixHeading"\/>/.test(x),
    'typed numbers are gone from the heading text; the appendix uses its own style');
  ok(/ SEQ Table \\\* ARABIC /.test(x) && / SEQ Figure \\\* ARABIC /.test(x) && !/>Table: Functional/.test(x) && /Functional requirements/.test(x),
    'captions are SEQ fields ("Table 1 — …"), and the "Table:" line is not printed again');
  const tables = x.split('<w:tbl>').slice(1);
  const reqTable = tables.find(t => t.includes('FR-01'));
  const grid = [...(reqTable ?? '').matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map(m => Number(m[1]));
  ok(grid.length === 3 && grid[1] > grid[0] * 3 && /<w:tblHeader\/>/.test(reqTable) && /<w:cantSplit\/>/.test(reqTable),
    'tables: widths from content in dxa, a repeating header row, rows that do not split', grid);
  ok((x.match(/<w:sectPr>/g) ?? []).length === 3 && /<w:pgNumType w:fmt="lowerRoman" w:start="1"\/>/.test(x) && /<w:pgNumType w:start="1"\/>/.test(x),
    'sections: cover, front matter (roman numbers), body (numbered from 1)');
  ok(/relativeFrom="page"/.test(x) && /<wps:wsp>/.test(x) && x.includes('XYZ Corporation') && x.includes('Document control') && x.includes('REVISION HISTORY'),
    'a full-bleed cover (page-anchored shapes) and a document-control page');
  const footers = Object.keys(zip).filter(n => /footer\d\.xml$/.test(n)).map(n => strFromU8(zip[n]));
  ok(footers.some(f => / SECTIONPAGES /.test(f) && / PAGE /.test(f) && f.includes('Version 1.0')) && footers.some(f => /\\\* roman/.test(f)),
    'footers: "Page X of Y" counting the body, the version, roman numbers in the front matter');
  const headers = Object.keys(zip).filter(n => /header\d\.xml$/.test(n)).map(n => strFromU8(zip[n]));
  ok(headers.some(h => h.includes('SharePoint SE — Technical Proposal') && h.includes('XYZ Corporation') && h.includes('INTERNAL')), 'running header: title, client, classification');
  const core = strFromU8(zip['docProps/core.xml']);
  ok(/<dc:subject>Technical proposal<\/dc:subject>/.test(core) && /<cp:keywords>[^<]*XYZ Corporation/.test(core) && zip['docProps/app.xml']
    && strFromU8(zip['[Content_Types].xml']).includes('/docProps/app.xml'), 'document properties: subject, keywords, version; app.xml registered');
  ok(strFromU8(zip['word/settings.xml']).includes('<w:updateFields w:val="true"/>') && / TOC \\o "1-3" \\h \\z \\u /.test(x), 'a TOC field that Word refreshes on open');
  if (haveBrowser) {
    ok(/ PAGEREF _Toc_1_executive_summary \\h /.test(x) && /PAGEREF _Toc_2_requirements \\h <\/w:instrText><\/w:r><w:r><w:fldChar w:fldCharType="separate"\/><\/w:r><w:r><w:t xml:space="preserve">\d+</.test(x),
      'TOC entries carry PAGEREF fields pre-filled with pages read from a printed layout (not "1")');
  } else ok(true, 'no browser: TOC page numbers left for Word to fill (checked where a browser is installed)');
  const mammoth = await import('mammoth');
  const conv = await mammoth.default.convertToHtml({ buffer: out.bytes });
  ok(/<h1>(<a id="[^"]*"><\/a>)?Executive Summary/.test(conv.value) && /<table>/.test(conv.value), 'an independent reader (mammoth) reads Heading 1 and the tables', conv.messages.slice(0, 3));

  // ── HTML and PDF ──
  const html = (await exportCanvas(doc, { format: 'html', resolveImage: imgs })).bytes.toString('utf8');
  ok(html.includes('<b>Table 1</b> — Functional requirements') && !/<p>Table: Functional/.test(html) && /<span class="hnum">1<\/span> Executive Summary/.test(html)
    && /<colgroup><col style="width:\d+\.\d%">/.test(html) && html.includes('class="fit tv-matrix"') && html.includes('<tr class="total">'),
  'html: numbered captions, outline labels, fitted columns, a matrix and a total row');
  ok(html.includes('cover-page cover-band at-top') && html.includes('class="front-page doc-control"') && html.includes('Appendix A —'),
    'html: the band cover, the control page and the appendix label');
  if (haveBrowser) {
    const pdf = await exportCanvas(doc, { format: 'pdf', resolveImage: imgs });
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(pdf.bytes) });
    const pages = (await parser.getText()).pages.map(p => p.text.replace(/\s+/g, ' '));
    await parser.destroy();
    const execAt = pages.findIndex((p, i) => i > 2 && /1 Executive Summary/.test(p));
    const contents = pages.find(p => /Contents/.test(p) && /aico-toc-end|Executive Summary/.test(p)) ?? '';
    ok(pdf.tocPageNumbers === true && /Executive Summary\s*1\b/.test(contents) && execAt >= 0 && /Page 1 of \d+/.test(pages[execAt]),
      'pdf: the TOC lists body page numbers, the body is numbered from 1 after the cover and front matter', { execAt, contents: contents.slice(0, 200) });
    ok(!/Page \d+ of/.test(pages[0]) && /\bi\b/.test(pages[1] ?? ''), 'pdf: no running footer on the cover; roman numbers on the front matter');
  } else ok(true, 'no browser: PDF checks skipped');
}

console.log(`\nDocument design: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
