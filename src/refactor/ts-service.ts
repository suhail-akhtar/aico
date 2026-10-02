/**
 * TypeScript/JavaScript refactors without an editor: the TypeScript language
 * service, driven directly.
 *
 * ## Why
 *
 * `VSCodeRename` and `VSCodeReferences` reach the real language server, but
 * only when VS Code is attached — not in the terminal, the browser workspace,
 * the desktop app, a cron job or a sub-agent. The engine for those answers is
 * the same one VS Code uses for TypeScript: `typescript`'s language service.
 * Rename, find references, organize imports and "move file, update imports"
 * are each one call to it, and each is exact where `Grep` + `Edit` is a guess:
 * it follows imports, re-exports and `import * as m`, and leaves a string or a
 * comment that merely contains the name alone.
 *
 * ## Which `typescript`
 *
 * The project's own first: its version is the one its `tsc` checks with, so a
 * rename it computes is one the project's typecheck agrees with. AICO's copy
 * second (a development install has one; a packaged install may not — it is a
 * build tool here, not a runtime dependency, ADR 0013). Loaded with
 * `createRequire` at call time, never imported, so no bundle carries it.
 *
 * ## What it deliberately does not do
 *
 * - Other languages. Python (pyright) and Go (gopls) speak LSP and would need
 *   a client; recorded as future work in ADR 0013, not half-built here.
 * - Keep a service warm between calls. Each call builds the program from disk:
 *   seconds on a few hundred files, and never a stale answer about files the
 *   agent has since edited.
 * - Rename through an alias. An export renamed at its declaration is renamed
 *   at every import and re-export, and at every importer of those re-exports
 *   (`export { a as old }` would keep the old public name, which is not what
 *   "rename the API" means); a shorthand property `{ old }` becomes
 *   `{ old: renamed }`, so object keys never change by accident.
 *
 * @module refactor/ts-service
 */

import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import type * as TS from 'typescript';
import type { FileChange } from './plan.js';

type TsModule = typeof TS;

const TS_MISSING =
  'The TypeScript language service is not available: `typescript` was found neither in this project\'s '
  + 'node_modules nor in AICO\'s own install. Install it in the project (`npm i -D typescript`), or use '
  + 'CodeRewrite (ast-grep) / Grep + Edit instead.';

/** Load `typescript`, the project's own first. Throws a message the model can act on. */
export function loadTypeScript(root: string): { ts: TsModule; from: 'project' | 'aico' } {
  try {
    const req = createRequire(path.join(root, 'package.json'));
    return { ts: req('typescript') as TsModule, from: 'project' };
  } catch { /* not in the project: AICO's own, below */ }
  try {
    const req = createRequire(import.meta.url);
    return { ts: req('typescript') as TsModule, from: 'aico' };
  } catch {
    throw new Error(TS_MISSING);
  }
}

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
/**
 * A path as the service keys it: forward slashes. Rename and references
 * tolerate backslashes; `getEditsForFileRename` does not, and silently
 * returned no importer edits for a Windows path (found by the moveFile test).
 */
export function tsPath(file: string): string {
  return path.resolve(file).split(path.sep).join('/');
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next']);

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), out); }
    else if (SOURCE.test(e.name) && !e.name.endsWith('.d.ts')) out.push(path.join(dir, e.name));
  }
}

/** A language service over the project at `root`, reading files from disk. */
export class ProjectService {
  readonly ts: TsModule;
  readonly ls: TS.LanguageService;
  readonly files: string[];
  readonly from: 'project' | 'aico';
  private readonly texts = new Map<string, string>();
  private readonly parsed = new Map<string, TS.SourceFile>();

  constructor(readonly root: string) {
    const { ts, from } = loadTypeScript(root);
    this.ts = ts;
    this.from = from;
    const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
    let options: TS.CompilerOptions;
    let files: string[];
    if (configPath && path.dirname(configPath).startsWith(root)) {
      const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, path.dirname(configPath));
      options = parsed.options;
      files = parsed.fileNames;
      // Files the config leaves out (tests in a separate config, scripts) still
      // import the API being renamed; a rename that skipped them would break them.
      const extra: string[] = [];
      walk(root, extra);
      const seen = new Set(files.map(f => path.resolve(f)));
      for (const f of extra) if (!seen.has(path.resolve(f)) && /\.(ts|tsx|mts|cts)$/i.test(f)) files.push(f);
    } else {
      options = { allowJs: true, checkJs: false, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve };
      files = [];
      walk(root, files);
    }
    this.files = files.map(tsPath);
    const host: TS.LanguageServiceHost = {
      getScriptFileNames: () => this.files,
      getScriptVersion: () => '1',
      getScriptSnapshot: (f) => {
        const text = this.read(f);
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => root,
      getCompilationSettings: () => options,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      fileExists: (f) => ts.sys.fileExists(f),
      readFile: (f) => this.read(f),
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
    };
    this.ls = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  /** A file's text as the service sees it (and as the plan's `before`). */
  read(file: string): string | undefined {
    const key = path.resolve(file);
    if (this.texts.has(key)) return this.texts.get(key);
    let text: string | undefined;
    try { text = fs.readFileSync(key, 'utf8'); } catch { text = undefined; }
    if (text !== undefined) this.texts.set(key, text);
    return text;
  }

  /**
   * The position of `symbol` in `file`.
   *
   * With a line: the occurrence on that line (1-indexed, as `Read` numbers
   * them), and the ambiguity reported rather than guessed when there are
   * several. Without one: the declaration of that name in the file, else its
   * first use — the usual case being "rename the thing this file exports".
   */
  locate(file: string, symbol: string, line?: number, occurrence?: number): number {
    const text = this.read(file);
    if (text === undefined) throw new Error(`Cannot read ${file}.`);
    const ts = this.ts;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const hits: TS.Identifier[] = [];
    const visit = (node: TS.Node): void => {
      if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && node.text === symbol) hits.push(node as TS.Identifier);
      node.forEachChild(visit);
    };
    visit(source);
    if (hits.length === 0) throw new Error(`"${symbol}" does not appear as an identifier in ${this.relative(file)}.`);
    const lineOf = (n: TS.Node): number => source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;
    if (line !== undefined) {
      const onLine = hits.filter(h => lineOf(h) === line);
      if (onLine.length === 0) {
        throw new Error(`"${symbol}" is not on line ${line} of ${this.relative(file)}; it is on line(s) ${[...new Set(hits.map(lineOf))].slice(0, 12).join(', ')}.`);
      }
      if (onLine.length > 1 && !occurrence) {
        throw new Error(`"${symbol}" appears ${onLine.length} times on line ${line}; pass occurrence (1–${onLine.length}).`);
      }
      const pick = onLine[(occurrence ?? 1) - 1];
      if (!pick) throw new Error(`occurrence ${occurrence} is out of range (1–${onLine.length}).`);
      return pick.getStart(source);
    }
    const declared = hits.find(h => {
      const p = h.parent as TS.Node & { name?: TS.Node };
      return p && p.name === h && (ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isVariableDeclaration(p)
        || ts.isInterfaceDeclaration(p) || ts.isTypeAliasDeclaration(p) || ts.isEnumDeclaration(p) || ts.isMethodDeclaration(p)
        || ts.isPropertyDeclaration(p) || ts.isModuleDeclaration(p) || ts.isParameter(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p));
    });
    return (declared ?? hits[0]!).getStart(source);
  }

  /** Whether the identifier starting at `pos` is a shorthand property (`{ name }`). */
  isShorthandProperty(file: string, pos: number): boolean {
    const text = this.read(file);
    if (text === undefined) return false;
    const ts = this.ts;
    let source = this.parsed.get(file);
    if (!source) { source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true); this.parsed.set(file, source); }
    const sf = source;
    let found = false;
    const visit = (node: TS.Node): void => {
      if (found || pos < node.pos || pos >= node.end) return;
      if (ts.isShorthandPropertyAssignment(node) && node.name.getStart(sf) === pos) { found = true; return; }
      node.forEachChild(visit);
    };
    visit(source);
    return found;
  }

  relative(file: string): string {
    return path.relative(this.root, file).split(path.sep).join('/');
  }

  /** Apply the service's text changes to the files they name. */
  changesFrom(edits: readonly TS.FileTextChanges[]): FileChange[] {
    const out: FileChange[] = [];
    for (const fileEdit of edits) {
      const file = path.resolve(fileEdit.fileName);
      const before = fileEdit.isNewFile ? null : (this.read(file) ?? null);
      let after = before ?? '';
      const sorted = [...fileEdit.textChanges].sort((a, b) => b.span.start - a.span.start);
      for (const c of sorted) after = after.slice(0, c.span.start) + c.newText + after.slice(c.span.start + c.span.length);
      out.push({ file, before, after, edits: fileEdit.textChanges.length });
    }
    return out;
  }
}

/** Every file inside `root` the service could touch must stay inside it. */
function insideRoot(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export interface SymbolRef { file: string; line: number; symbol: string; occurrence?: number }

/** Rename a symbol across the project. */
export function renameChanges(svc: ProjectService, ref: SymbolRef, newName: string): { changes: FileChange[]; notes: string[] } {
  if (!/^[A-Za-z_$][\w$]*$/.test(newName)) throw new Error(`"${newName}" is not a valid identifier.`);
  const pos = svc.locate(ref.file, ref.symbol, ref.line || undefined, ref.occurrence);
  const info = svc.ls.getRenameInfo(tsPath(ref.file), pos, { allowRenameOfImportPath: false });
  if (!info.canRename) throw new Error(`TypeScript will not rename this: ${info.localizedErrorMessage}`);
  /*
    Neither of the service's modes is the rename a person means. Without
    prefix/suffix text it follows the name through every re-export to every
    importer, but turns `{ old }` into `{ renamed }` — an object key silently
    changed. With it, keys are kept, but it stops at the first re-export and
    aliases it back (`export { renamed as old }`), leaving the barrel's
    importers on the old name (measured: a barrel importer was simply absent
    from the plan). So the first mode's locations, and the one shape it gets
    wrong — a shorthand property — fixed here from the syntax tree.
  */
  const locations = svc.ls.findRenameLocations(tsPath(ref.file), pos, false, false, { providePrefixAndSuffixTextForRename: false }) ?? [];
  const byFile = new Map<string, TS.TextChange[]>();
  const notes: string[] = [];
  let outside = 0;
  for (const loc of locations) {
    const file = path.resolve(loc.fileName);
    if (!insideRoot(svc.root, file) || file.includes(`${path.sep}node_modules${path.sep}`)) { outside++; continue; }
    const prefix = svc.isShorthandProperty(file, loc.textSpan.start) ? `${ref.symbol}: ` : '';
    const list = byFile.get(file) ?? [];
    list.push({ span: loc.textSpan, newText: `${prefix}${newName}` });
    byFile.set(file, list);
  }
  if (outside) notes.push(`${outside} location(s) outside the project (node_modules, declaration files) were left alone.`);
  const changes = svc.changesFrom([...byFile].map(([fileName, textChanges]) => ({ fileName, textChanges })));
  return { changes, notes };
}

/** Every reference to a symbol, one line each, capped. */
export function findReferences(svc: ProjectService, ref: SymbolRef, max = 300): string {
  const pos = svc.locate(ref.file, ref.symbol, ref.line || undefined, ref.occurrence);
  const groups = svc.ls.findReferences(tsPath(ref.file), pos) ?? [];
  const lines: string[] = [];
  let count = 0;
  const files = new Set<string>();
  for (const g of groups) {
    for (const r of g.references) {
      const file = path.resolve(r.fileName);
      if (!insideRoot(svc.root, file)) continue;
      count++;
      files.add(file);
      if (lines.length >= max) continue;
      const text = svc.read(file) ?? '';
      const before = text.slice(0, r.textSpan.start);
      const lineNo = before.split('\n').length;
      const lineText = text.split('\n')[lineNo - 1] ?? '';
      lines.push(`${svc.relative(file)}:${lineNo}${r.isDefinition ? ' (definition)' : ''}: ${lineText.trim().slice(0, 160)}`);
    }
  }
  if (count === 0) return `No references to "${ref.symbol}" found.`;
  return [`${count} reference(s) to "${ref.symbol}" in ${files.size} file(s):`, ...lines,
    ...(count > max ? [`… ${count - max} more.`] : [])].join('\n');
}

function formatSettings(ts: TsModule, sample: string | undefined): TS.FormatCodeSettings {
  return {
    ...ts.getDefaultFormatCodeSettings(sample?.includes('\r\n') ? '\r\n' : '\n'),
    // Keep the file's quote and semicolon habits rather than imposing ours.
    semicolons: ts.SemicolonPreference.Ignore,
  };
}

/** Organize (sort, merge, drop unused) one file's imports. */
export function organizeImportsChanges(svc: ProjectService, file: string): FileChange[] {
  const ts = svc.ts;
  const edits = svc.ls.organizeImports({ type: 'file', fileName: tsPath(file) }, formatSettings(ts, svc.read(file)), { quotePreference: 'auto' });
  return svc.changesFrom(edits);
}

/**
 * Move a file and update every import of it, and its own relative imports.
 * The move itself is a create plus a delete in the plan, so a rollback puts
 * the file back where it was.
 */
export function moveFileChanges(svc: ProjectService, from: string, to: string): FileChange[] {
  const ts = svc.ts;
  const text = svc.read(from);
  if (text === undefined) throw new Error(`Cannot read ${from}.`);
  if (fs.existsSync(to)) throw new Error(`${svc.relative(to)} already exists; choose a new path or remove it first.`);
  const edits = svc.ls.getEditsForFileRename(tsPath(from), tsPath(to), formatSettings(ts, text), { quotePreference: 'auto', importModuleSpecifierEnding: 'auto' });
  const changes = svc.changesFrom(edits);
  // The moved file's own edits (its relative imports) belong to its new path.
  const own = changes.find(c => c.file === path.resolve(from));
  const movedText = own?.after ?? text;
  const others = changes.filter(c => c !== own);
  return [
    ...others,
    { file: path.resolve(from), before: text, after: null, edits: 1 },
    { file: path.resolve(to), before: null, after: movedText, edits: (own?.edits ?? 0) + 1 },
  ];
}
