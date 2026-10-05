/**
 * TypeScript and JavaScript: imports, re-exports, requires, exports with
 * signatures, and how each imported binding is used.
 *
 * Runs on masked code (codegraph/lex), so an `import` in a comment or a
 * function name in a string is never read. Statement starts are anchored at a
 * line start or after `;`/`}` so `foo.import(...)` or `x.export` never match.
 *
 * The parse records bindings, not just module names, because "who uses
 * `formatAmount`" is a question about bindings: `import { money } from
 * '@/components/ui'` uses `formatAmount` if that barrel re-exports it under
 * that name, and `import * as fmt` uses it only where the file says
 * `fmt.formatAmount`. Following those to the declaring file is resolution's
 * job (codegraph/resolve); recording them faithfully is this file's.
 *
 * @module codegraph/parse/js
 */

import { headerFrom, identifierLines, lineAt, mask, memberLines, normaliseSig, stringAt, type Masked } from '../lex.js';
import type { ExportDecl, ImportBinding, ParsedFile, RawImport } from '../types.js';
import { extractMembers, withMembers } from './members.js';

const ID = '[A-Za-z_$][\\w$]*';
const STMT = '(?:^|[;}\\n])[ \\t]*';

/** `a, b as c, type d, default as e` → bindings. */
function parseNamedList(body: string): Array<ImportBinding & { typeOnly?: boolean }> {
  const out: Array<ImportBinding & { typeOnly?: boolean }> = [];
  for (const raw of body.split(',')) {
    let part = raw.trim();
    if (!part) continue;
    let typeOnly = false;
    if (/^type\s+/.test(part)) { typeOnly = true; part = part.replace(/^type\s+/, ''); }
    const m = new RegExp(`^(${ID}|'[^']*'|"[^"]*")(?:\\s+as\\s+(${ID}))?$`).exec(part);
    if (!m) continue;
    const imported = m[1]!.replace(/^['"]|['"]$/g, '');
    out.push({ imported, local: m[2] ?? imported, ...(typeOnly ? { typeOnly } : {}) });
  }
  return out;
}

function sigAt(code: string, start: number, kind: string): string {
  if (kind === 'function' || kind === 'method') return normaliseSig(headerFrom(code, start, ['{', ';']));
  if (kind === 'const' || kind === 'let' || kind === 'var') {
    // `export const f = (a: T): R => …` — up to the arrow, or the end of the line for a value.
    const header = headerFrom(code, start, ['=>', ';', '\n']);
    return normaliseSig(header);
  }
  if (kind === 'type') return normaliseSig(headerFrom(code, start, [';', '\n\n']));
  return normaliseSig(headerFrom(code, start, ['{', ';', '\n']));
}

export function parseJs(source: string, lang: 'ts' | 'js'): ParsedFile {
  const m = mask(source, 'js');
  const code = m.code;
  const imports: RawImport[] = [];
  const exports: ExportDecl[] = [];
  const localExports: ImportBinding[] = [];
  const skip: Array<[number, number]> = [];
  const bound = new Set<string>();
  const nsBound = new Set<string>();

  const spec = (at: number): string | undefined => stringAt(m, at)?.value;

  // import … from '…'
  const importFrom = new RegExp(`${STMT}import\\s+(type\\s+)?([^;'"\`]*?)\\s*from\\s*(?=['"])`, 'g');
  for (const x of code.matchAll(importFrom)) {
    const quoteAt = x.index! + x[0].length;
    const s = spec(quoteAt);
    if (s === undefined) continue;
    const typeOnly = Boolean(x[1]);
    const clause = x[2]!.trim();
    const rec: RawImport = { spec: s, line: lineAt(m, quoteAt), kind: 'static', ...(typeOnly ? { typeOnly } : {}) };
    const names: ImportBinding[] = [];
    // default, * as ns, { named }
    const brace = /\{([\s\S]*)\}/.exec(clause);
    if (brace) {
      const list = parseNamedList(brace[1]!);
      for (const b of list) names.push({ imported: b.imported, local: b.local });
      if (list.length > 0 && list.every(b => b.typeOnly)) rec.typeOnly = true;
    }
    const nsm = new RegExp(`\\*\\s*as\\s+(${ID})`).exec(clause);
    if (nsm) rec.ns = nsm[1]!;
    const head = clause.replace(/\{[\s\S]*\}/, '').replace(/\*\s*as\s+[\w$]+/, '').replace(/,/g, ' ').trim();
    if (head && new RegExp(`^${ID}$`).test(head)) names.push({ imported: 'default', local: head });
    if (names.length) rec.names = names;
    for (const b of names) bound.add(b.local);
    if (rec.ns) { bound.add(rec.ns); nsBound.add(rec.ns); }
    imports.push(rec);
    skip.push([x.index!, (stringAt(m, quoteAt)?.end ?? quoteAt)]);
  }

  // import '…' (side effect)
  for (const x of code.matchAll(new RegExp(`${STMT}import\\s*(?=['"])`, 'g'))) {
    const at = x.index! + x[0].length;
    const s = spec(at);
    if (s !== undefined) imports.push({ spec: s, line: lineAt(m, at), kind: 'side-effect' });
  }

  // import x = require('…') (TypeScript)
  for (const x of code.matchAll(new RegExp(`${STMT}import\\s+(${ID})\\s*=\\s*require\\s*\\(\\s*(?=['"])`, 'g'))) {
    const at = x.index! + x[0].length;
    const s = spec(at);
    if (s === undefined) continue;
    imports.push({ spec: s, line: lineAt(m, at), kind: 'require', ns: x[1]! });
    bound.add(x[1]!); nsBound.add(x[1]!);
    skip.push([x.index!, at + s.length + 2]);
  }

  // const { a, b: c } = require('…') / const x = require('…') / require('…')
  for (const x of code.matchAll(/\brequire\s*\(\s*(?=['"])/g)) {
    const at = x.index! + x[0].length;
    const s = spec(at);
    if (s === undefined) continue;
    const before = code.slice(Math.max(0, x.index! - 200), x.index!);
    const destr = new RegExp(`(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*$`).exec(before);
    const whole = new RegExp(`(?:const|let|var)\\s+(${ID})\\s*=\\s*$`).exec(before);
    const rec: RawImport = { spec: s, line: lineAt(m, at), kind: 'require' };
    if (destr) {
      const names: ImportBinding[] = [];
      for (const part of destr[1]!.split(',')) {
        const p = /^\s*([\w$]+)\s*(?::\s*([\w$]+))?\s*$/.exec(part);
        if (p) names.push({ imported: p[1]!, local: p[2] ?? p[1]! });
      }
      if (names.length) rec.names = names;
      for (const b of names) bound.add(b.local);
      skip.push([x.index! - destr[0].length, at + s.length + 2]);
    } else if (whole) {
      rec.ns = whole[1]!;
      bound.add(whole[1]!); nsBound.add(whole[1]!);
      skip.push([x.index! - whole[0].length, at + s.length + 2]);
    }
    if (!imports.some(i => i.kind === 'require' && i.line === rec.line && i.spec === s)) imports.push(rec);
  }

  // import('…') — a dynamic import is still a dependency.
  for (const x of code.matchAll(/(?<![\w$.])import\s*\(\s*(?=['"])/g)) {
    const at = x.index! + x[0].length;
    const s = spec(at);
    if (s === undefined) continue;
    const rec: RawImport = { spec: s, line: lineAt(m, at), kind: 'dynamic' };
    // `const m = await import('…')` binds a namespace; `const { a } = await import('…')` names.
    const before = code.slice(Math.max(0, x.index! - 200), x.index!);
    const whole = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?$/.exec(before);
    const destr = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?$/.exec(before);
    if (whole) { rec.ns = whole[1]!; bound.add(whole[1]!); nsBound.add(whole[1]!); }
    else if (destr) {
      const names: ImportBinding[] = [];
      for (const part of destr[1]!.split(',')) {
        const p = /^\s*([\w$]+)\s*(?::\s*([\w$]+))?\s*$/.exec(part);
        if (p) names.push({ imported: p[1]!, local: p[2] ?? p[1]! });
      }
      if (names.length) { rec.names = names; for (const b of names) bound.add(b.local); }
    }
    imports.push(rec);
  }

  // export * from '…' / export * as ns from '…' / export { a as b } from '…'
  for (const x of code.matchAll(new RegExp(`${STMT}export\\s+(type\\s+)?(\\*(?:\\s*as\\s+(${ID}))?|\\{[^}]*\\})\\s*from\\s*(?=['"])`, 'g'))) {
    const at = x.index! + x[0].length;
    const s = spec(at);
    if (s === undefined) continue;
    const what = x[2]!;
    const rec: RawImport = { spec: s, line: lineAt(m, at), kind: 'static', ...(x[1] ? { typeOnly: true } : {}) };
    if (what.startsWith('*')) {
      if (x[3]) rec.reexport = [{ imported: '*', local: x[3] }];
      else rec.reexport = 'all';
    } else {
      rec.reexport = parseNamedList(what.slice(1, -1)).map(b => ({ imported: b.imported, local: b.local }));
    }
    imports.push(rec);
    skip.push([x.index!, at + s.length + 2]);
  }

  // Declarations.
  const declRe = /(?:^|[;}\n])[ \t]*export\s+(?<def>default\s+)?(?:declare\s+)?(?:(?:async\s+)?function\s*\*?\s*(?<fn>[A-Za-z_$][\w$]*)?(?=\s*[(<])|(?:abstract\s+)?class(?:\s+(?<cls>[A-Za-z_$][\w$]*))?|(?:const\s+)?enum\s+(?<en>[A-Za-z_$][\w$]*)|(?<vk>const|let|var)\s+(?<vn>[A-Za-z_$][\w$]*)|(?<tk>interface|type|namespace|module)\s+(?<tn>[A-Za-z_$][\w$]*))/g;
  for (const x of code.matchAll(declRe)) {
    const g = x.groups ?? {};
    const at = code.indexOf('export', x.index!);
    const line = lineAt(m, at);
    let name: string | undefined;
    let kind = 'value';
    if (/\bfunction\b/.test(x[0])) { name = g.fn; kind = 'function'; }
    else if (/\bclass\b/.test(x[0])) { name = g.cls; kind = 'class'; }
    else if (g.en) { name = g.en; kind = 'enum'; }
    else if (g.vk) { name = g.vn; kind = g.vk; }
    else if (g.tk) { name = g.tn; kind = g.tk === 'module' ? 'namespace' : g.tk; }
    const sig = sigAt(code, at, kind);
    if (g.def) {
      exports.push({ name: 'default', kind, line, sig });
      if (name) localExports.push({ imported: name, local: 'default' });
    } else if (name) {
      exports.push({ name, kind, line, sig });
    }
  }
  // export const { a, b } = … (rare): names only.
  for (const x of code.matchAll(new RegExp(`${STMT}export\\s+(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=`, 'g'))) {
    const line = lineAt(m, x.index! + x[0].indexOf('export'));
    for (const part of x[1]!.split(',')) {
      const p = /([\w$]+)\s*$/.exec(part.trim());
      if (p) exports.push({ name: p[1]!, kind: 'const', line, sig: normaliseSig(part) });
    }
  }
  // export default <identifier>;
  for (const x of code.matchAll(new RegExp(`${STMT}export\\s+default\\s+(?!function\\b|class\\b|async\\b|abstract\\b)(${ID})\\s*;?`, 'g'))) {
    const at = code.indexOf('export', x.index!);
    exports.push({ name: 'default', kind: 'value', line: lineAt(m, at), sig: normaliseSig(x[0]) });
    localExports.push({ imported: x[1]!, local: 'default' });
  }
  // export default <expression> (object, arrow, call): a default export with no name.
  for (const x of code.matchAll(new RegExp(`${STMT}export\\s+default\\s+(?=[({\\[<'"\`])`, 'g'))) {
    const at = code.indexOf('export', x.index!);
    if (!exports.some(e => e.name === 'default')) exports.push({ name: 'default', kind: 'value', line: lineAt(m, at), sig: 'export default' });
  }
  // export { a, b as c }  (no from)
  for (const x of code.matchAll(new RegExp(`${STMT}export\\s+(type\\s+)?\\{([^}]*)\\}(?!\\s*from)`, 'g'))) {
    const line = lineAt(m, code.indexOf('export', x.index!));
    for (const b of parseNamedList(x[2]!)) {
      localExports.push({ imported: b.imported, local: b.local });
      if (!exports.some(e => e.name === b.local)) exports.push({ name: b.local, kind: 'alias', line, sig: normaliseSig(`export { ${b.imported}${b.imported !== b.local ? ` as ${b.local}` : ''} }`) });
    }
  }
  // CommonJS: module.exports = { a, b: c } / exports.a = / module.exports.a =
  for (const x of code.matchAll(/(?:^|[;\n])\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)) {
    const line = lineAt(m, x.index! + 1);
    if (!exports.some(e => e.name === x[1])) exports.push({ name: x[1]!, kind: 'cjs', line, sig: normaliseSig(headerFrom(code, x.index!, ['{', ';', '\n'])) });
  }
  for (const x of code.matchAll(/(?:^|[;\n])\s*module\.exports\s*=\s*\{([^}]*)\}/g)) {
    const line = lineAt(m, x.index! + 1);
    for (const part of x[1]!.split(',')) {
      const p = /^\s*([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?/.exec(part);
      if (!p) continue;
      if (!exports.some(e => e.name === p[1])) exports.push({ name: p[1]!, kind: 'cjs', line, sig: normaliseSig(part) });
      if (p[2]) localExports.push({ imported: p[2], local: p[1]! });
    }
  }

  // How each binding is used, outside its own import.
  const uses = identifierLines(m, bound, skip);
  const members = memberLines(m, bound, skip);

  const parsed: ParsedFile = {
    lang,
    imports,
    exports: dedupe(exports),
    ...(localExports.length ? { localExports } : {}),
    uses,
    members,
    ...(entryOf(source) ? { entry: entryOf(source)! } : {}),
    loc: m.lineStarts.length,
  };
  // Classes, interfaces and the method calls whose receiver type the text states (parse/members).
  return withMembers(parsed, extractMembers(m, source, lang, bound, skip), m);
}

function dedupe(list: ExportDecl[]): ExportDecl[] {
  const seen = new Set<string>();
  return list.filter(e => (seen.has(e.name) ? false : (seen.add(e.name), true)));
}

/**
 * Content that makes a file an entry point: an HTTP server or route table.
 * Read from the source (route paths are strings, which masking blanks), on
 * lines that do not start as comments.
 */
function entryOf(source: string): string | undefined {
  if (/^(?![ \t]*(?:\/\/|\*|\/\*)).*\b(?:app|router|server|api)\s*\.\s*(?:get|post|put|patch|delete|route|use)\s*\(\s*['"`]\//m.test(source)) return 'routes';
  if (/^(?![ \t]*(?:\/\/|\*|\/\*)).*\.listen\s*\(\s*(?:\d|port|PORT|process\.env)/m.test(source)) return 'server';
  if (/^#!.*\bnode\b/.test(source)) return 'cli';
  return undefined;
}

export type { Masked };
