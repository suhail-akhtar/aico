/**
 * Java, Kotlin, C#, PHP, Ruby and Rust: package/namespace, imports, type and
 * function declarations, and the identifiers that could name a declaration
 * in scope.
 *
 * These languages resolve most cross-file references by *scope* rather than
 * by an import per name — the same package (Java, Kotlin), the namespaces a
 * file is in or `using`s (C#), autoloading (Ruby on Rails), `use` trees
 * (Rust, PHP). So beside the imports, each file records the capitalised
 * identifiers it mentions (`refs`), and resolution links one only when it
 * names exactly one declaration in the scopes the language says are visible.
 * Ambiguity leaves no edge.
 *
 * @module codegraph/parse/others
 */

import { headerFrom, lineAt, mask, normaliseSig, type LexFamily, type Masked } from '../lex.js';
import type { ExportDecl, ImportBinding, Lang, ParsedFile, RawImport } from '../types.js';
import { extractMembers, withMembers } from './members.js';

/** The local names a file's imports bind (simple names of imported types, aliases). */
function importedNames(imports: RawImport[], sep: string): Set<string> {
  const out = new Set<string>();
  for (const i of imports) {
    for (const b of i.names ?? []) out.add(b.local);
    if (!i.names?.length && i.kind !== 'wildcard') out.add(i.spec.split(sep).pop()!);
  }
  return out;
}

/** Capitalised identifiers used outside `skip`, bounded. */
function typeRefs(m: Masked, skip: Array<[number, number]>, re = /(?<![\w$])([A-Z][A-Za-z0-9_]*)\b/g): string[] {
  const out = new Set<string>();
  for (const x of m.code.matchAll(re)) {
    if (out.size >= 2000) break;
    if (skip.some(([a, b]) => x.index! >= a && x.index! < b)) continue;
    out.add(x[1]!);
  }
  return [...out];
}

function decl(m: Masked, code: string, at: number, name: string, kind: string, stops: string[], internal?: boolean): ExportDecl {
  return { name, kind, line: lineAt(m, at), sig: normaliseSig(headerFrom(code, at, stops)), ...(internal ? { internal } : {}) };
}

export function parseJvm(source: string, lang: 'java' | 'kotlin'): ParsedFile {
  const m = mask(source, lang === 'java' ? 'java' : 'kotlin');
  const code = m.code;
  const imports: RawImport[] = [];
  const exports: ExportDecl[] = [];
  const skip: Array<[number, number]> = [];
  const pkg = /(?:^|\n)\s*package\s+([\w.]+)/.exec(code)?.[1];
  for (const x of code.matchAll(/(?:^|\n)\s*import\s+(static\s+)?([\w.]+)(\.\*)?(?:\s+as\s+(\w+))?\s*;?/g)) {
    const at = x.index! + (x[0].startsWith('\n') ? 1 : 0);
    const rec: RawImport = { spec: x[2]!, line: lineAt(m, at), kind: x[3] ? 'wildcard' : x[1] ? 'static-member' : 'static' };
    if (x[4]) rec.names = [{ imported: x[2]!.split('.').pop()!, local: x[4] }];
    imports.push(rec);
    skip.push([x.index!, x.index! + x[0].length]);
  }
  const typeRe = /(?:^|\n)[ \t]*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|protected|private|internal|abstract|final|sealed|open|data|static|inline|value|enum|annotation|inner|strictfp|non-sealed)\s+)*(class|interface|enum|record|object|@interface)\s+([A-Za-z_]\w*)/g;
  for (const x of code.matchAll(typeRe)) {
    const at = x.index! + x[0].indexOf(x[1]!);
    const internal = /\bprivate\b/.test(x[0]);
    exports.push(decl(m, code, at, x[2]!, x[1]!, ['{', '\n'], internal));
  }
  if (lang === 'kotlin') {
    for (const x of code.matchAll(/(?:^|\n)(?:(?:public|internal|private|inline|suspend|operator|infix|tailrec)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)\s*\(/g)) {
      const at = x.index! + (x[0].startsWith('\n') ? 1 : 0);
      exports.push(decl(m, code, at, x[1]!, 'function', ['{', '=', '\n'], /\bprivate\b/.test(x[0])));
    }
  }
  const entry = /\bstatic\s+void\s+main\s*\(/.test(code) || /(?:^|\n)fun\s+main\s*\(/.test(code) ? 'main'
    : /@SpringBootApplication\b/.test(code) ? 'main'
      : /@(?:RestController|Controller|GetMapping|PostMapping|RequestMapping)\b/.test(code) ? 'routes' : undefined;
  const parsed: ParsedFile = { lang, imports, exports, uses: {}, members: {}, ...(pkg ? { pkg } : {}), refs: typeRefs(m, skip), ...(entry ? { entry } : {}), loc: m.lineStarts.length };
  return withMembers(parsed, extractMembers(m, source, lang, importedNames(imports, '.'), skip), m);
}

export function parseCSharp(source: string): ParsedFile {
  const m = mask(source, 'cs');
  const code = m.code;
  const imports: RawImport[] = [];
  const exports: ExportDecl[] = [];
  const skip: Array<[number, number]> = [];
  const namespaces = [...code.matchAll(/(?:^|\n)\s*namespace\s+([\w.]+)/g)].map(x => x[1]!);
  for (const x of code.matchAll(/(?:^|\n)\s*(?:global\s+)?using\s+(static\s+)?(?:(\w+)\s*=\s*)?([\w.]+)\s*;/g)) {
    const at = x.index! + (x[0].startsWith('\n') ? 1 : 0);
    const rec: RawImport = { spec: x[3]!, line: lineAt(m, at), kind: x[1] ? 'static-member' : 'wildcard' };
    if (x[2]) { rec.names = [{ imported: x[3]!.split('.').pop()!, local: x[2] }]; rec.kind = 'static'; }
    imports.push(rec);
    skip.push([x.index!, x.index! + x[0].length]);
  }
  const typeRe = /(?:^|\n)[ \t]*(?:\[[^\]\n]*\]\s*)*(?:(?:public|internal|protected|private|abstract|sealed|static|partial|readonly|ref|unsafe|new|file)\s+)*(class|interface|struct|enum|record(?:\s+(?:class|struct))?)\s+([A-Za-z_]\w*)/g;
  for (const x of code.matchAll(typeRe)) {
    const at = x.index! + x[0].indexOf(x[1]!);
    exports.push(decl(m, code, at, x[2]!, x[1]!.split(/\s+/)[0]!, ['{', ';', '\n'], /\bprivate\b|\bfile\b/.test(x[0])));
  }
  const entry = /\bstatic\s+(?:async\s+)?(?:void|int|Task(?:<int>)?)\s+Main\s*\(/.test(code) ? 'main'
    : /\bWebApplication\.CreateBuilder\b|\bapp\.Map(?:Get|Post|Put|Delete)\s*\(/.test(code) ? 'main'
      : /\[(?:ApiController|HttpGet|HttpPost|Route)\b/.test(code) ? 'routes' : undefined;
  const parsed: ParsedFile = { lang: 'cs', imports, exports, uses: {}, members: {}, ...(namespaces.length ? { namespaces } : {}), refs: typeRefs(m, skip), ...(entry ? { entry } : {}), loc: m.lineStarts.length };
  return withMembers(parsed, extractMembers(m, source, 'cs', new Set(imports.flatMap(i => i.names?.map(b => b.local) ?? [])), skip), m);
}

export function parsePhp(source: string): ParsedFile {
  const m = mask(source, 'php');
  const code = m.code;
  const imports: RawImport[] = [];
  const exports: ExportDecl[] = [];
  const skip: Array<[number, number]> = [];
  const pkg = /(?:^|\n|<\?php)\s*namespace\s+([\w\\]+)\s*[;{]/.exec(code)?.[1];
  for (const x of code.matchAll(/(?:^|\n)\s*use\s+(function\s+|const\s+)?([\w\\]+)(?:\\\{([^}]*)\}|\s+as\s+(\w+))?\s*;/g)) {
    const at = x.index! + (x[0].startsWith('\n') ? 1 : 0);
    const line = lineAt(m, at);
    if (x[3] !== undefined) {
      for (const part of x[3].split(',')) {
        const p = /^\s*([\w\\]+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
        if (!p) continue;
        const fq = `${x[2]!.replace(/\\$/, '')}\\${p[1]}`;
        const short = fq.split('\\').pop()!;
        imports.push({ spec: fq, line, kind: 'static', names: [{ imported: short, local: p[2] ?? short }] });
      }
    } else {
      const short = x[2]!.split('\\').pop()!;
      imports.push({ spec: x[2]!, line, kind: 'static', names: [{ imported: short, local: x[4] ?? short }] });
    }
    skip.push([x.index!, x.index! + x[0].length]);
  }
  for (const x of code.matchAll(/\b(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?(?=['"])/g)) {
    const at = x.index! + x[0].length;
    const lit = m.strings.find(s => s.start === at);
    if (lit) imports.push({ spec: lit.value, line: lineAt(m, at), kind: 'include' });
  }
  for (const x of code.matchAll(/(?:^|\n)[ \t]*(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+([A-Za-z_]\w*)/g)) {
    const at = x.index! + x[0].indexOf(x[1]!);
    exports.push(decl(m, code, at, x[2]!, x[1]!, ['{', '\n']));
  }
  for (const x of code.matchAll(/(?:^|\n)function\s+([A-Za-z_]\w*)\s*\(/g)) {
    const at = x.index! + (x[0].startsWith('\n') ? 1 : 0);
    exports.push(decl(m, code, at, x[1]!, 'function', ['{']));
  }
  // Fully qualified references inline (`new \App\Models\User`).
  const refs = new Set(typeRefs(m, skip));
  for (const x of code.matchAll(/\\?((?:[A-Z]\w*\\)+[A-Z]\w*)/g)) refs.add(x[1]!);
  const entry = /\bRoute::(?:get|post|put|patch|delete|resource)\s*\(/.test(code) ? 'routes' : undefined;
  const parsed: ParsedFile = { lang: 'php', imports, exports, uses: {}, members: {}, ...(pkg ? { pkg } : {}), refs: [...refs].slice(0, 2000), ...(entry ? { entry } : {}), loc: m.lineStarts.length };
  return withMembers(parsed, extractMembers(m, source, 'php', new Set<string>(), skip), m);
}

export function parseRuby(source: string): ParsedFile {
  const m = mask(source, 'rb');
  const code = m.code;
  const imports: RawImport[] = [];
  const exports: ExportDecl[] = [];
  const skip: Array<[number, number]> = [];
  for (const x of code.matchAll(/\b(require_relative|require|load)\s*\(?\s*(?=['"])/g)) {
    const at = x.index! + x[0].length;
    const lit = m.strings.find(s => s.start === at);
    if (!lit) continue;
    imports.push({ spec: lit.value, line: lineAt(m, at), kind: x[1] === 'require_relative' ? 'include' : 'require' });
    skip.push([x.index!, lit.end]);
  }
  for (const x of code.matchAll(/(?:^|\n)[ \t]*(class|module)\s+([A-Z][\w]*(?:::[A-Z]\w*)*)/g)) {
    const at = x.index! + x[0].indexOf(x[1]!);
    const name = x[2]!.split('::').pop()!;
    exports.push(decl(m, code, at, name, x[1]!, ['\n', '<']));
  }
  for (const x of code.matchAll(/(?:^|\n)def\s+(?:self\.)?([a-z_]\w*[?!=]?)/g)) {
    const at = x.index! + (x[0].startsWith('\n') ? 1 : 0);
    exports.push(decl(m, code, at, x[1]!, 'function', ['\n']));
  }
  const parsed: ParsedFile = { lang: 'rb', imports, exports, uses: {}, members: {}, refs: typeRefs(m, skip), loc: m.lineStarts.length };
  return withMembers(parsed, extractMembers(m, source, 'rb', new Set<string>(), skip), m);
}

/** Flatten a Rust use tree: `a::b::{c, d::e as f, self}` → paths with optional alias. */
export function flattenUse(tree: string): Array<{ path: string; alias?: string }> {
  const out: Array<{ path: string; alias?: string }> = [];
  const walk = (prefix: string, body: string): void => {
    // Split top-level commas.
    let depth = 0;
    let cur = '';
    const parts: string[] = [];
    for (const ch of body) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) parts.push(cur);
    for (const raw of parts) {
      const part = raw.trim();
      if (!part) continue;
      const brace = part.indexOf('{');
      if (brace >= 0) {
        const head = part.slice(0, brace).replace(/::\s*$/, '').trim();
        walk(prefix ? (head ? `${prefix}::${head}` : prefix) : head, part.slice(brace + 1, part.lastIndexOf('}')));
        continue;
      }
      const as = /^(.*?)\s+as\s+(\w+)$/.exec(part);
      const p = (as ? as[1]! : part).trim();
      const full = p === 'self' ? prefix : prefix ? `${prefix}::${p}` : p;
      out.push({ path: full, ...(as ? { alias: as[2]! } : {}) });
    }
  };
  walk('', tree);
  return out;
}

export function parseRust(source: string): ParsedFile {
  const m = mask(source, 'rs');
  const code = m.code;
  const imports: RawImport[] = [];
  const exports: ExportDecl[] = [];
  const skip: Array<[number, number]> = [];
  for (const x of code.matchAll(/(?:^|\n)\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([a-z_]\w*)\s*;/g)) {
    const at = x.index! + (x[0].startsWith('\n') ? 1 : 0);
    imports.push({ spec: `mod:${x[1]}`, line: lineAt(m, at), kind: 'include' });
  }
  for (const x of code.matchAll(/(?:^|\n)\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);/g)) {
    const at = x.index! + (x[0].startsWith('\n') ? 1 : 0);
    const line = lineAt(m, at);
    for (const u of flattenUse(x[1]!.replace(/\s+/g, ' '))) {
      const last = u.path.split('::').pop()!;
      const names: ImportBinding[] = last === '*' ? [] : [{ imported: last, local: u.alias ?? last }];
      imports.push({ spec: u.path, line, kind: last === '*' ? 'wildcard' : 'static', ...(names.length ? { names } : {}) });
    }
    skip.push([x.index!, x.index! + x[0].length]);
  }
  for (const x of code.matchAll(/(?:^|\n)[ \t]*(pub(?:\([^)]*\))?\s+)?(?:async\s+|const\s+|unsafe\s+|extern\s+"C"\s+)*(fn|struct|enum|trait|type|const|static|union)\s+([A-Za-z_]\w*)/g)) {
    const at = x.index! + x[0].indexOf(x[2]!);
    exports.push(decl(m, code, at, x[3]!, x[2]!, ['{', ';', 'where'], !x[1]));
  }
  const entry = /(?:^|\n)\s*(?:async\s+)?fn\s+main\s*\(/.test(code) ? 'main' : undefined;
  const parsed: ParsedFile = { lang: 'rs', imports, exports, uses: {}, members: {}, refs: typeRefs(m, skip), ...(entry ? { entry } : {}), loc: m.lineStarts.length };
  // Module-qualified names (`money::add`) are paths, not variables: the `use`d module names are imports.
  return withMembers(parsed, extractMembers(m, source, 'rs', new Set<string>(), skip), m);
}

export const FAMILY: Record<Lang, LexFamily> = { ts: 'js', js: 'js', py: 'py', go: 'go', java: 'java', kotlin: 'kotlin', cs: 'cs', php: 'php', rb: 'rb', rs: 'rs' };
