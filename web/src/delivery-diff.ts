/**
 * Unified-diff parsing and a light line highlighter for the Delivery drawer.
 *
 * WHY its own parser: the repo's existing diff views (shared/ui/FileDiff for a
 * tool call's arguments, ChangesPane's per-line colouring) take one file's
 * pre-split text. A task's diff is the whole branch against the trunk — many
 * files in one string — and the reviewer needs per-file sections they can
 * collapse, with +/- counts and line numbers. Parsing is the part worth
 * testing, so it lives here, pure.
 *
 * What it does not do: compute diffs, or highlight like an editor. The
 * highlighter is deliberately line-local (strings, comments, numbers, a short
 * keyword list): enough to make code scan, never wrong across lines because it
 * never claims to know a multi-line construct.
 *
 * @module web/delivery-diff
 */

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'note';

export interface DiffLine { kind: DiffLineKind; text: string; oldNo?: number; newNo?: number }
export interface DiffHunk { header: string; lines: DiffLine[] }
export interface DiffFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'deleted' | 'renamed' | 'modified';
  binary: boolean;
  added: number;
  removed: number;
  hunks: DiffHunk[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function stripPrefix(p: string): string {
  return p.replace(/^"?[ab]\//, '').replace(/"$/, '');
}

/** Parse `git diff` output into files. Tolerates a missing `diff --git` header (a bare ---/+++ pair) and CRLF. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const start = (path: string): DiffFile => {
    const f: DiffFile = { path, status: 'modified', binary: false, added: 0, removed: 0, hunks: [] };
    files.push(f);
    hunk = null;
    return f;
  };

  const rows = text.split('\n');
  // The final newline leaves one empty string that is not a context line.
  if (rows.length && rows[rows.length - 1] === '') rows.pop();

  for (const raw of rows) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line);
      file = start(m ? m[2]! : line.slice(11));
      if (m && m[1] !== m[2]) file.oldPath = m[1]!;
      continue;
    }
    // A diff without `diff --git` headers: a `--- ` outside a hunk opens the next file.
    if (!hunk && line.startsWith('--- ') && (!file || file.hunks.length > 0)) file = start('');
    if (!file) continue;

    if (!hunk) {
      if (line.startsWith('new file mode')) file.status = 'added';
      else if (line.startsWith('deleted file mode')) file.status = 'deleted';
      else if (line.startsWith('rename from ')) { file.status = 'renamed'; file.oldPath = line.slice(12); }
      else if (line.startsWith('rename to ')) file.path = line.slice(10);
      else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) file.binary = true;
      else if (line.startsWith('--- ')) {
        const p = line.slice(4).trim();
        if (p === '/dev/null') file.status = 'added';
        else if (!file.path) file.path = stripPrefix(p);
        continue;
      } else if (line.startsWith('+++ ')) {
        const p = line.slice(4).trim();
        if (p === '/dev/null') file.status = 'deleted';
        else if (!file.path || file.status === 'deleted') file.path = stripPrefix(p);
        continue;
      }
    }
    const h = HUNK.exec(line);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('+')) { hunk.lines.push({ kind: 'add', text: line.slice(1), newNo: newNo++ }); file.added++; }
    else if (line.startsWith('-')) { hunk.lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++ }); file.removed++; }
    else if (line.startsWith('\\')) hunk.lines.push({ kind: 'note', text: line.slice(1).trim() });
    else hunk.lines.push({ kind: 'ctx', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
  }
  return files.filter(f => f.path || f.hunks.length);
}

export function diffTotals(files: readonly DiffFile[]): { files: number; added: number; removed: number } {
  return { files: files.length, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) };
}

// ── light highlighting ───────────────────────────────────────────────

export type TokenKind = 'kw' | 'str' | 'com' | 'num';
export interface Token { text: string; kind?: TokenKind }

const KEYWORDS = new Set((
  'const let var function return if else for while do switch case break continue new class extends import export from default async await try catch finally throw typeof instanceof ' +
  'def lambda pass raise with as yield in is not and or None True False self ' +
  'fn pub use mod impl struct enum trait match mut ' +
  'func package type interface go defer range ' +
  'true false null undefined void public private static final int string boolean'
).split(' '));

const HASH_COMMENT = new Set(['py', 'sh', 'bash', 'yml', 'yaml', 'rb', 'toml', 'ini', 'conf']);
const SLASH_COMMENT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'java', 'go', 'rs', 'c', 'h', 'cpp', 'cs', 'css', 'scss', 'swift', 'kt', 'php', 'json']);

export function extOf(path: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return m ? m[1]!.toLowerCase() : '';
}

/** Split one line into coloured runs. Unknown languages come back as a single plain token. */
export function highlightLine(text: string, ext: string): Token[] {
  const hash = HASH_COMMENT.has(ext);
  const slash = SLASH_COMMENT.has(ext);
  if (!hash && !slash) return [{ text }];
  const out: Token[] = [];
  let plain = '';
  const flush = (): void => { if (plain) { out.push({ text: plain }); plain = ''; } };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if ((slash && c === '/' && text[i + 1] === '/') || (hash && c === '#')) {
      flush(); out.push({ text: text.slice(i), kind: 'com' }); return out;
    }
    if (slash && c === '/' && text[i + 1] === '*') {
      flush();
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out.push({ text: text.slice(i, stop), kind: 'com' }); i = stop; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      flush();
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      const stop = Math.min(text.length, j + 1);
      out.push({ text: text.slice(i, stop), kind: 'str' }); i = stop; continue;
    }
    if (/[0-9]/.test(c) && !/[A-Za-z_$]/.test(text[i - 1] ?? '')) {
      flush();
      let j = i + 1;
      while (j < text.length && /[0-9a-fA-FxX._]/.test(text[j]!)) j++;
      out.push({ text: text.slice(i, j), kind: 'num' }); i = j; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_$]/.test(text[j]!)) j++;
      const word = text.slice(i, j);
      if (KEYWORDS.has(word)) { flush(); out.push({ text: word, kind: 'kw' }); } else plain += word;
      i = j; continue;
    }
    plain += c; i++;
  }
  flush();
  return out;
}
