/**
 * Python: `import` and `from … import` in every form, top-level definitions
 * with their signatures, and how each imported name is used.
 *
 * `from app import billing` binds either a submodule or a name, and only
 * resolution can tell which — so both views are recorded: the plain uses of
 * `billing`, and its `billing.member` uses. Imports inside functions count
 * (a lazy import is still a dependency); `if TYPE_CHECKING:` imports are
 * dependencies too and are not singled out.
 *
 * @module codegraph/parse/python
 */

import { headerFrom, identifierLines, lineAt, mask, memberLines, normaliseSig } from '../lex.js';
import type { ExportDecl, ImportBinding, ParsedFile, RawImport } from '../types.js';
import { extractMembers, withMembers } from './members.js';

const NAME = '[A-Za-z_][\\w]*';
const DOTTED = `${NAME}(?:\\s*\\.\\s*${NAME})*`;

export function parsePython(source: string): ParsedFile {
  const m = mask(source, 'py');
  const code = m.code;
  const imports: RawImport[] = [];
  const exports: ExportDecl[] = [];
  const skip: Array<[number, number]> = [];
  const bound = new Set<string>();
  const qualifiers = new Set<string>();

  // import a.b.c [as x], d
  for (const x of code.matchAll(new RegExp(`(?:^|\\n)[ \\t]*import[ \\t]+([^\\n;]+)`, 'g'))) {
    const line = lineAt(m, x.index! + (x[0].startsWith('\n') ? 1 : 0));
    for (const part of x[1]!.split(',')) {
      const p = new RegExp(`^\\s*(${DOTTED})(?:\\s+as\\s+(${NAME}))?\\s*$`).exec(part);
      if (!p) continue;
      const dotted = p[1]!.replace(/\s+/g, '');
      const local = p[2] ?? dotted;
      imports.push({ spec: dotted, line, ns: local, kind: 'static' });
      bound.add(local.split('.')[0]!);
      qualifiers.add(local);
    }
    skip.push([x.index!, x.index! + x[0].length]);
  }

  // from .a.b import x [as y], (multi, line), *
  for (const x of code.matchAll(new RegExp(`(?:^|\\n)[ \\t]*from[ \\t]+(\\.*)[ \\t]*(${DOTTED})?[ \\t]+import[ \\t]+(\\([^)]*\\)|[^\\n;]+)`, 'g'))) {
    const line = lineAt(m, x.index! + (x[0].startsWith('\n') ? 1 : 0));
    const level = x[1]!.length;
    const mod = (x[2] ?? '').replace(/\s+/g, '');
    const list = x[3]!.replace(/[()\\]/g, ' ');
    const rec: RawImport = { spec: mod, line, kind: 'static', ...(level ? { level } : {}) };
    if (list.trim() === '*') {
      rec.reexport = 'all';
      rec.kind = 'wildcard';
    } else {
      const names: ImportBinding[] = [];
      for (const part of list.split(',')) {
        const p = new RegExp(`^\\s*(${NAME})(?:\\s+as\\s+(${NAME}))?\\s*$`).exec(part);
        if (p) names.push({ imported: p[1]!, local: p[2] ?? p[1]! });
      }
      if (names.length) rec.names = names;
      for (const b of names) { bound.add(b.local); qualifiers.add(b.local); }
    }
    imports.push(rec);
    skip.push([x.index!, x.index! + x[0].length]);
  }

  // Top-level definitions (column 0).
  for (const x of code.matchAll(new RegExp(`(?:^|\\n)((?:async[ \\t]+)?def|class)[ \\t]+(${NAME})`, 'g'))) {
    const at = x.index! + (x[0].startsWith('\n') ? 1 : 0);
    const kind = x[1]!.includes('def') ? 'function' : 'class';
    const sig = normaliseSig(headerFrom(code, at, [':']));
    exports.push({ name: x[2]!, kind, line: lineAt(m, at), sig, ...(x[2]!.startsWith('_') ? { internal: true } : {}) });
  }
  for (const x of code.matchAll(new RegExp(`(?:^|\\n)(${NAME})[ \\t]*(?::[^=\\n]+)?=(?!=)`, 'g'))) {
    const name = x[1]!;
    if (['if', 'elif', 'else', 'while', 'for', 'return'].includes(name)) continue;
    const at = x.index! + (x[0].startsWith('\n') ? 1 : 0);
    if (exports.some(e => e.name === name)) continue;
    exports.push({ name, kind: 'value', line: lineAt(m, at), sig: normaliseSig(code.slice(at, code.indexOf('\n', at) === -1 ? undefined : code.indexOf('\n', at))), ...(name.startsWith('_') ? { internal: true } : {}) });
  }

  const uses = identifierLines(m, bound, skip, 5, /[A-Za-z_][\w]*/g);
  const members = memberLines(m, qualifiers, skip);
  // The `__main__` string is blanked in the masked code; the check reads the source at column 0.
  const entry = /(?:^|\n)if\s+__name__\s*==\s*['"]__main__['"]/.test(source) ? 'main'
    : /@(?:app|router|bp|api|blueprint)\.(?:get|post|put|patch|delete|route|websocket)\s*\(/.test(code) ? 'routes'
      : undefined;
  // Classes, their methods and fields, and calls on receivers of a known type (parse/members).
  return withMembers({ lang: 'py', imports, exports, uses, members, ...(entry ? { entry } : {}), loc: m.lineStarts.length }, extractMembers(m, source, 'py', bound, skip), m);
}
