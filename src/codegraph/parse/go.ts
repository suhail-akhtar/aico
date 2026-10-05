/**
 * Go: the package clause, imports (single, grouped, aliased, blank, dot),
 * top-level declarations with signatures, and `pkg.Member` uses.
 *
 * A Go import names a *directory*, and the name the importing file uses is
 * the imported package's **package clause**, which need not match the folder
 * (`internal/service/orders` can be `package ordering`). That is unknown
 * while parsing one file, so every `lower.Upper` pair is recorded and
 * resolution matches it against the package clause it finds — the case that
 * made other indexers resolve no Go package at all.
 *
 * Same-package references are recorded as plain identifiers (`refs`): files
 * of one package share a scope, and a name declared once in the package is
 * exact, not a guess.
 *
 * @module codegraph/parse/go
 */

import { headerFrom, lineAt, mask, normaliseSig } from '../lex.js';
import type { ExportDecl, ParsedFile, RawImport } from '../types.js';
import { extractMembers, withMembers } from './members.js';

export function parseGo(source: string): ParsedFile {
  const m = mask(source, 'go');
  const code = m.code;
  const imports: RawImport[] = [];
  const exports: ExportDecl[] = [];
  const skip: Array<[number, number]> = [];

  const pkg = /(?:^|\n)\s*package\s+([A-Za-z_]\w*)/.exec(code)?.[1];

  const addImport = (alias: string | undefined, at: number): void => {
    const lit = m.strings.find(s => s.start === at);
    if (!lit) return;
    const rec: RawImport = { spec: lit.value, line: lineAt(m, at), kind: 'static' };
    if (alias && alias !== '_' && alias !== '.') rec.ns = alias;
    if (alias === '.') rec.kind = 'wildcard';
    if (alias === '_') rec.kind = 'side-effect';
    imports.push(rec);
  };
  for (const x of code.matchAll(/(?:^|\n)\s*import\s*\(([\s\S]*?)\)/g)) {
    const bodyStart = x.index! + x[0].indexOf('(') + 1;
    for (const line of x[1]!.matchAll(/(?:^|\n)\s*([A-Za-z_]\w*|\.)?\s*(?=")/g)) {
      addImport(line[1], bodyStart + line.index! + line[0].length);
    }
    skip.push([x.index!, x.index! + x[0].length]);
  }
  for (const x of code.matchAll(/(?:^|\n)\s*import\s+([A-Za-z_]\w*|\.)?\s*(?=")/g)) {
    addImport(x[1], x.index! + x[0].length);
    skip.push([x.index!, x.index! + x[0].length + 2]);
  }

  // func (r *T) Name(…) / func Name(…)
  for (const x of code.matchAll(/(?:^|\n)func\s+(?:\(\s*(?:[A-Za-z_]\w*\s+)?\*?\s*([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)\s*)?([A-Za-z_]\w*)/g)) {
    const at = x.index! + (x[0].startsWith('\n') ? 1 : 0);
    const name = x[1] ? `${x[1]}.${x[2]}` : x[2]!;
    const exported = /^[A-Z]/.test(x[2]!) && (!x[1] || /^[A-Z]/.test(x[1]));
    exports.push({ name, kind: x[1] ? 'method' : 'function', line: lineAt(m, at), sig: normaliseSig(headerFrom(code, at, ['{', '\n'])), ...(exported ? {} : { internal: true }) });
  }
  // type T … / var X / const X, single and grouped.
  for (const x of code.matchAll(/(?:^|\n)(type|var|const)\s+(\(([\s\S]*?)\n\)|([A-Za-z_]\w*)[^\n]*)/g)) {
    const kind = x[1]!;
    const at = x.index! + (x[0].startsWith('\n') ? 1 : 0);
    const decl = (name: string, offset: number, text: string): void => {
      exports.push({ name, kind, line: lineAt(m, offset), sig: normaliseSig(text), ...(/^[A-Z]/.test(name) ? {} : { internal: true }) });
    };
    if (x[4]) decl(x[4], at, x[2]!.split('{')[0]!);
    else if (x[3] !== undefined) {
      const groupStart = x.index! + x[0].indexOf('(') + 1;
      for (const y of x[3].matchAll(/(?:^|\n)\s*([A-Za-z_]\w*)\b([^\n]*)/g)) {
        decl(y[1]!, groupStart + y.index!, `${y[1]}${y[2]}`.split('{')[0]!);
      }
    }
  }

  // Interfaces and their method names: Go satisfies interfaces structurally, so an
  // implementation edge can only come from comparing method sets (resolve.ts).
  const ifaces: Record<string, string[]> = {};
  for (const x of code.matchAll(/(?:^|\n)\s*(?:type\s+)?([A-Za-z_]\w*)\s+interface\s*\{/g)) {
    const open = x.index! + x[0].length;
    let depth = 1;
    let j = open;
    while (j < code.length && depth > 0) { if (code[j] === '{') depth++; else if (code[j] === '}') depth--; j++; }
    // `Name|Type,Type`: the method and the named types in its signature, for telling
    // apart implementers that share method names (every store has `Insert`).
    const methods = [...code.slice(open, j - 1).matchAll(/(?:^|\n)\s*([A-Za-z_]\w*)\s*(\([^\n]*)/g)].map(y => `${y[1]!}|${goTypeKey(y[2]!)}`);
    if (methods.length) ifaces[x[1]!] = methods;
  }

  // pkg.Member uses, for every lower-case qualifier (the package clause is resolved later).
  const members: Record<string, Record<string, number[]>> = {};
  for (const x of code.matchAll(/(?<![\w.])([a-z_]\w*)\s*\.\s*([A-Z]\w*)/g)) {
    if (skip.some(([a, b]) => x.index! >= a && x.index! < b)) continue;
    const byMember = (members[x[1]!] ??= {});
    const list = (byMember[x[2]!] ??= []);
    const line = lineAt(m, x.index!);
    if (list.length < 5 && list[list.length - 1] !== line) list.push(line);
  }
  // Identifiers used, for same-package resolution (bounded).
  const refs = new Set<string>();
  for (const x of code.matchAll(/(?<![\w.])([A-Za-z_]\w*)\b/g)) {
    if (refs.size >= 3000) break;
    if (!GO_KEYWORDS.has(x[1]!)) refs.add(x[1]!);
  }

  const entry = pkg === 'main' && /(?:^|\n)func\s+main\s*\(/.test(code) ? 'main'
    : /^(?![ \t]*\/\/).*\.(?:HandleFunc|Handle|Get|Post|Put|Patch|Delete)\s*\(\s*"\//m.test(source) ? 'routes' : undefined;
  const parsed: ParsedFile = {
    lang: 'go', imports, exports, uses: {}, members, ...(pkg ? { pkg } : {}),
    refs: [...refs], ...(entry ? { entry } : {}), ...(Object.keys(ifaces).length ? { ifaces } : {}), loc: m.lineStarts.length,
  };
  // Package names a file may qualify with: aliases and the last path segment (the clause is checked at resolution).
  const qualifiers = new Set(imports.map(i => i.ns ?? i.spec.split('/').pop()!).filter(Boolean));
  return withMembers(parsed, extractMembers(m, source, 'go', qualifiers, skip), m);
}

/** The named types a signature mentions, package qualifiers dropped, sorted: `(ctx context.Context, o *ordering.Order) error` → `Context,Order`. */
export function goTypeKey(sig: string): string {
  return [...new Set([...sig.replace(/\b[a-z_]\w*\./g, '').matchAll(/\b([A-Z]\w*)/g)].map(m => m[1]!))].sort().join(',');
}

const GO_KEYWORDS = new Set(['break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var', 'nil', 'true', 'false', 'string', 'int', 'int64', 'int32', 'error', 'bool', 'byte', 'rune', 'float64', 'any', 'len', 'make', 'append', 'new', 'cap', 'panic', 'recover', 'copy', 'delete', 'close', 'print', 'println']);
