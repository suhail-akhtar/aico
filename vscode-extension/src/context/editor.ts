/**
 * What the editor knows and the agent cannot find out for itself.
 *
 * The whole value of running inside an IDE is here. Asked "why is this
 * failing?" in a terminal, an agent has to go looking for what you were staring
 * at; in an editor that is already known, and sending it costs one message
 * instead of four tool calls.
 *
 * ## What is inlined, and what is only named
 *
 * The distinction is the design, and it is about who *can* find a thing out:
 *
 * - **Inlined** — the selection, and the Problems for a file. Neither is
 *   recoverable by an agent with file tools. It cannot know which forty lines
 *   you highlighted, and it certainly cannot run your language server. This is
 *   information that exists nowhere else.
 * - **Named only** — file paths, open tabs. aico has `Read`, `Grep` and `Glob`;
 *   pasting a 900-line file into the prompt spends context on something it can
 *   fetch precisely, and does it whether or not the file turns out to matter.
 *
 * Getting this backwards is how an editor integration ends up sending fifteen
 * thousand tokens of open tabs with every "hello".
 *
 * @module context/editor
 */

import * as vscode from 'vscode';

/** A file the conversation should know about, without its contents. */
export interface FileRef {
  /** Workspace-relative where possible; absolute when outside the folder. */
  path: string;
  /** Absolute, for the panel to key on. Never shown. */
  uri: string;
  language?: string;
}

export interface SelectionRef extends FileRef {
  /** 1-based and inclusive, matching what the editor's gutter shows. */
  fromLine: number;
  toLine: number;
  text: string;
  /** True when the selection was cut short — see `MAX_SELECTION_CHARS`. */
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
  /** How many problems there are in total, when `problems` was cut short. */
  problemTotal: number;
}

/**
 * A ceiling on an inlined selection.
 *
 * Selecting a whole file with Ctrl+A and pressing the shortcut is a normal
 * thing to do by accident, and without a bound it silently sends the file twice
 * — once as text and once as a path. The truncation is reported rather than
 * hidden so the agent knows to read the rest rather than assume it has it all.
 */
const MAX_SELECTION_CHARS = 8_000;

/** Problems worth naming. Beyond this the list stops being read. */
const MAX_PROBLEMS = 12;

/** Open tabs worth naming, most recently used first. */
const MAX_TABS = 12;

/**
 * Selection changes fire on every mouse move during a drag.
 *
 * Each one would be a `postMessage` and a React render. The delay is short
 * enough to feel immediate and long enough that dragging across a file is one
 * update rather than two hundred.
 */
const SETTLE_MS = 150;

export class EditorContextSource implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private last = '';

  constructor(private readonly onChange: (context: EditorContext) => void) {
    const schedule = (): void => this.schedule();

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(schedule),
      vscode.window.onDidChangeTextEditorSelection(schedule),
      vscode.window.tabGroups.onDidChangeTabs(schedule),
      /*
        Diagnostics arrive well after a file opens — a language server has to
        start, index, and analyse. Without this the Problems chip is absent for
        the first few seconds of every session and appears only if something
        else happens to trigger a refresh.
      */
      vscode.languages.onDidChangeDiagnostics(schedule),
    );
  }

  /** Send the current state now, whatever the timer is doing. */
  push(): void {
    this.last = '';
    this.emit();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.emit(), SETTLE_MS);
  }

  private emit(): void {
    const context = this.read();
    /*
      Only when something actually differs.

      `onDidChangeDiagnostics` fires for every file a language server touches,
      including files nobody has open. Re-sending an identical payload would
      re-render the panel's chips continuously while a large project indexes.
    */
    const signature = JSON.stringify(context);
    if (signature === this.last) return;
    this.last = signature;
    this.onChange(context);
  }

  read(): EditorContext {
    const editor = vscode.window.activeTextEditor;
    const active = editor ? toRef(editor.document) : null;

    let selection: SelectionRef | null = null;
    if (editor && !editor.selection.isEmpty && active) {
      const raw = editor.document.getText(editor.selection);
      selection = {
        ...active,
        fromLine: editor.selection.start.line + 1,
        toLine: editor.selection.end.line + 1,
        text: raw.slice(0, MAX_SELECTION_CHARS),
        truncated: raw.length > MAX_SELECTION_CHARS,
      };
    }

    return {
      active,
      selection,
      tabs: this.openTabs(active),
      ...this.problemsFor(editor?.document.uri),
    };
  }

  private openTabs(active: FileRef | null): FileRef[] {
    const seen = new Set<string>();
    const tabs: FileRef[] = [];

    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (!(input instanceof vscode.TabInputText)) continue;
        const uri = input.uri.toString();
        // The active file is offered as its own chip; listing it again as a
        // tab would make it look like two pieces of context.
        if (uri === active?.uri || seen.has(uri)) continue;
        seen.add(uri);
        tabs.push({
          path: vscode.workspace.asRelativePath(input.uri, false),
          uri,
        });
        if (tabs.length >= MAX_TABS) return tabs;
      }
    }
    return tabs;
  }

  private problemsFor(uri: vscode.Uri | undefined): Pick<EditorContext, 'problems' | 'problemTotal'> {
    if (!uri) return { problems: [], problemTotal: 0 };

    const relevant = vscode.languages.getDiagnostics(uri).filter(d =>
      d.severity === vscode.DiagnosticSeverity.Error
      || d.severity === vscode.DiagnosticSeverity.Warning);

    /*
      Errors before warnings, then by line.

      A file mid-edit routinely has forty warnings and one error, and the error
      is the reason you are asking. Sorting by line would bury it.
    */
    relevant.sort((a, b) =>
      (a.severity - b.severity) || (a.range.start.line - b.range.start.line));

    const path = vscode.workspace.asRelativePath(uri, false);
    return {
      problemTotal: relevant.length,
      problems: relevant.slice(0, MAX_PROBLEMS).map(d => ({
        path,
        uri: uri.toString(),
        line: d.range.start.line + 1,
        severity: d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning',
        message: d.message.replace(/\s+/g, ' ').trim(),
        source: d.source,
      })),
    };
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
  }
}

function toRef(document: vscode.TextDocument): FileRef {
  return {
    path: vscode.workspace.asRelativePath(document.uri, false),
    uri: document.uri.toString(),
    language: document.languageId,
  };
}
