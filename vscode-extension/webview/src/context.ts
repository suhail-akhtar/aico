/**
 * The editor's state, and what the composer will actually send.
 *
 * Two different things live here and the distinction matters:
 *
 * - **What the editor reports** (`EditorContext`) arrives from the host and is
 *   replaced wholesale whenever anything changes. It is never edited.
 * - **What is attached** is the user's decision — which of those the next
 *   message should carry, plus anything they added with `#`.
 *
 * Keeping them apart is what lets a chip be dismissed and *stay* dismissed while
 * the selection underneath it keeps changing. Merging them would resurrect a
 * chip on the next cursor move, which is the single most irritating way for this
 * kind of feature to behave.
 *
 * @module context
 */

import { vscodeApi } from './tunnel';

export interface FileRef {
  path: string;
  uri: string;
  language?: string;
}

export interface SelectionRef extends FileRef {
  fromLine: number;
  toLine: number;
  text: string;
  truncated: boolean;
}

export interface ProblemRef {
  path: string;
  uri: string;
  line: number;
  severity: 'error' | 'warning';
  message: string;
  source?: string;
}

export interface EditorContext {
  active: FileRef | null;
  selection: SelectionRef | null;
  tabs: FileRef[];
  problems: ProblemRef[];
  problemTotal: number;
}

export const EMPTY: EditorContext = {
  active: null, selection: null, tabs: [], problems: [], problemTotal: 0,
};

export interface FindResult {
  kind: 'file' | 'symbol';
  label: string;
  detail: string;
  uri: string;
  line?: number;
  symbolKind?: string;
}

type Listener = (context: EditorContext) => void;

const listeners = new Set<Listener>();
let latest: EditorContext = EMPTY;

const pendingFinds = new Map<number, (results: FindResult[]) => void>();
let nextFindId = 1;

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as { t?: string } | undefined;

  if (message?.t === 'context') {
    latest = (message as { context: EditorContext }).context;
    for (const listener of listeners) listener(latest);
    return;
  }

  if (message?.t === 'find:result') {
    const frame = message as { id: number; results: FindResult[] };
    const waiting = pendingFinds.get(frame.id);
    if (waiting) { pendingFinds.delete(frame.id); waiting(frame.results); }
  }
});

export function onEditorContext(listener: Listener): () => void {
  listener(latest);
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Ask the host for files and symbols matching `query`.
 *
 * Unanswered requests are dropped rather than retried. A search is superseded by
 * the next keystroke, and a menu that renders whichever answer happens to arrive
 * last shows results for a query the user has already finished typing past.
 */
export function findInWorkspace(query: string): Promise<FindResult[]> {
  const id = nextFindId; nextFindId += 1;
  return new Promise((resolve) => {
    pendingFinds.set(id, resolve);
    vscodeApi.postMessage({ t: 'find', id, query });
    setTimeout(() => {
      if (pendingFinds.delete(id)) resolve([]);
    }, 8000);
  });
}

/** Open a file in the editor, optionally at a line. */
export function reveal(uri: string, line?: number): void {
  vscodeApi.postMessage({ t: 'reveal', uri, line });
}

// ── what gets sent ───────────────────────────────────────────────────

/** A file the user pointed at with `#`. */
export interface PinnedRef extends FileRef {
  line?: number;
  /** The symbol name, when the pin came from a symbol rather than a file. */
  symbol?: string;
}

export interface Attachments {
  /** Chips the user dismissed, keyed by `chipKey`. */
  dismissed: Set<string>;
  /** Files and symbols added with `#`. */
  pinned: PinnedRef[];
  /** Whether the active file's Problems ride along. Off unless asked for. */
  problems: boolean;
}

export const NO_ATTACHMENTS: Attachments = {
  dismissed: new Set(), pinned: [], problems: false,
};

/**
 * A stable identity for a chip.
 *
 * Selections key on their line range as well as their file, so dismissing the
 * context for one function does not also dismiss it for the next one you
 * highlight in the same file. Dismissing is a judgement about *this* piece of
 * context, not a standing instruction about the file.
 */
export function chipKey(kind: string, uri: string, extra = ''): string {
  return `${kind}:${uri}${extra ? `:${extra}` : ''}`;
}

/**
 * Turn the attached context into the block that rides with the message.
 *
 * The shape of this is the design decision from `context/editor.ts`, applied:
 * a selection and a set of Problems are *inlined* because nothing else can
 * recover them, while files are *named* because aico has `Read` and can fetch
 * exactly the part it needs.
 *
 * Returns an empty string when there is nothing to say, so the caller can send
 * the message untouched rather than appending a heading with nothing under it.
 */
export function buildContextBlock(
  editor: EditorContext,
  attached: Attachments,
): string {
  const lines: string[] = [];

  const kept = <T,>(key: string, value: T | null): T | null =>
    value !== null && !attached.dismissed.has(key) ? value : null;

  const selection = editor.selection
    ? kept(chipKey('sel', editor.selection.uri, `${editor.selection.fromLine}-${editor.selection.toLine}`), editor.selection)
    : null;

  const active = editor.active
    ? kept(chipKey('file', editor.active.uri), editor.active)
    : null;

  if (selection) {
    const where = selection.fromLine === selection.toLine
      ? `line ${selection.fromLine}`
      : `lines ${selection.fromLine}-${selection.toLine}`;
    lines.push(`Selected in \`${selection.path}\`, ${where}:`);
    lines.push('');
    lines.push('```' + (selection.language ?? ''));
    lines.push(selection.text);
    lines.push('```');
    if (selection.truncated) {
      // Said plainly, because an agent that believes it has the whole selection
      // will reason about an ending that was never sent.
      lines.push('');
      lines.push('(The selection was longer than this; read the file for the rest.)');
    }
    lines.push('');
  }

  // Named, not pasted — the active file is where the reader is, which is worth
  // knowing even when its contents are not worth spending.
  if (active && (!selection || selection.uri !== active.uri)) {
    lines.push(`Open in the editor: \`${active.path}\``);
    lines.push('');
  }

  if (attached.pinned.length) {
    lines.push('Also relevant:');
    for (const pin of attached.pinned) {
      lines.push(pin.symbol
        ? `- \`${pin.path}\`${pin.line ? `:${pin.line}` : ''} — \`${pin.symbol}\``
        : `- \`${pin.path}\``);
    }
    lines.push('');
  }

  if (attached.problems && editor.problems.length) {
    const file = editor.problems[0].path;
    lines.push(`Problems reported in \`${file}\`:`);
    for (const problem of editor.problems) {
      const source = problem.source ? ` [${problem.source}]` : '';
      lines.push(`- ${problem.severity} at line ${problem.line}${source}: ${problem.message}`);
    }
    if (editor.problemTotal > editor.problems.length) {
      lines.push(`- …and ${editor.problemTotal - editor.problems.length} more.`);
    }
    lines.push('');
  }

  return lines.length ? lines.join('\n').trimEnd() : '';
}
