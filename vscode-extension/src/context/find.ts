/**
 * `#` in the composer: finding a file or a symbol to point at.
 *
 * ## Why `#` and not `@`
 *
 * `@` already means something in aico — it addresses a *specialist*, and
 * selecting one takes the token back out of the message because it is a control
 * rather than content. Reusing it for files would give the same key two meanings
 * across two surfaces of one product, which is worse than either choice on its
 * own. `#` is free here, and it is what VS Code users already type in Copilot
 * Chat to mean "this thing", so it costs nobody anything to learn.
 *
 * ## Files and symbols, not files or symbols
 *
 * Both, because people reach for whichever they remember. Sometimes you know the
 * file; more often you know a function name and would otherwise be searching for
 * the file that contains it — which is exactly the errand this exists to save.
 *
 * @module context/find
 */

import * as vscode from 'vscode';

export interface FindResult {
  kind: 'file' | 'symbol';
  /** What to show. For a symbol, its name. */
  label: string;
  /** Where it is, workspace-relative. */
  detail: string;
  uri: string;
  /** 1-based, for a symbol. Absent for a whole file. */
  line?: number;
  /** A VS Code SymbolKind name, for the icon. */
  symbolKind?: string;
}

/** Enough to choose from; more is a list nobody reads. */
const MAX_FILES = 12;
const MAX_SYMBOLS = 8;

/**
 * Find files and symbols matching `query`.
 *
 * The two searches run together rather than in sequence. A symbol provider can
 * take a second or more on a cold index, and serialising them would make the
 * file results — which are fast and usually what is wanted — wait for it.
 */
export async function find(query: string): Promise<FindResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return recentFiles();

  const [files, symbols] = await Promise.all([
    findFiles(trimmed),
    findSymbols(trimmed),
  ]);

  // Files first: a query that names a file is unambiguous, and a symbol match
  // for the same word is usually the same place reached the long way round.
  return [...files, ...symbols];
}

async function findFiles(query: string): Promise<FindResult[]> {
  // A loose glob, deliberately: the pattern below matches the query anywhere in
  // the path, so typing a directory name finds everything under it — which is
  // what someone typing `#server` means. Excludes are left to the user's own
  // `files.exclude` and `search.exclude` by passing `undefined`; a hard-coded
  // node_modules filter would be wrong in a repository that vendors its deps.
  //
  // (Written as line comments on purpose. A block comment describing a glob
  // contains `*` followed by `/`, which ends the comment three lines early and
  // produces a page of parse errors nowhere near the actual mistake.)
  const uris = await vscode.workspace.findFiles(
    `**/*${escapeGlob(query)}*`, undefined, MAX_FILES * 3,
  );

  const relative = uris.map(uri => ({
    uri,
    path: vscode.workspace.asRelativePath(uri, false),
  }));

  /*
    A match in the filename beats a match in the directory.

    `#config` should offer `config.ts` before `config/deeply/nested/other.ts`,
    and a plain glob returns them in directory order — which puts the thing you
    asked for below a dozen things that merely live near it.
  */
  const needle = query.toLowerCase();
  relative.sort((a, b) => score(a.path, needle) - score(b.path, needle));

  return relative.slice(0, MAX_FILES).map(({ uri, path }) => ({
    kind: 'file' as const,
    label: basename(path),
    detail: path,
    uri: uri.toString(),
  }));
}

function score(path: string, needle: string): number {
  const name = basename(path).toLowerCase();
  if (name === needle) return 0;
  if (name.startsWith(needle)) return 1;
  if (name.includes(needle)) return 2;
  return 3;
}

async function findSymbols(query: string): Promise<FindResult[]> {
  try {
    const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      'vscode.executeWorkspaceSymbolProvider', query,
    );
    if (!Array.isArray(symbols)) return [];

    return symbols.slice(0, MAX_SYMBOLS).map(symbol => ({
      kind: 'symbol' as const,
      label: symbol.name,
      detail: vscode.workspace.asRelativePath(symbol.location.uri, false),
      uri: symbol.location.uri.toString(),
      line: symbol.location.range.start.line + 1,
      symbolKind: vscode.SymbolKind[symbol.kind],
    }));
  } catch {
    /*
      No symbol provider is the normal case, not an error.

      A workspace of plain text, or one whose language server has not started,
      simply has no symbols. Failing the whole search because half of it found
      nothing would take the file results away too.
    */
    return [];
  }
}

/** With no query, offer what is already open — the likeliest thing meant. */
function recentFiles(): FindResult[] {
  const out: FindResult[] = [];
  const seen = new Set<string>();

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (!(tab.input instanceof vscode.TabInputText)) continue;
      const uri = tab.input.uri.toString();
      if (seen.has(uri)) continue;
      seen.add(uri);
      const path = vscode.workspace.asRelativePath(tab.input.uri, false);
      out.push({ kind: 'file', label: basename(path), detail: path, uri });
      if (out.length >= MAX_FILES) return out;
    }
  }
  return out;
}

/** `*`, `?`, `[` and `{` are glob syntax; a filename may contain them. */
function escapeGlob(value: string): string {
  return value.replace(/[*?[\]{}]/g, '');
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
