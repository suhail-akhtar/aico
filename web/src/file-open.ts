/**
 * Opening a project file at a line from the web client (ADR 0030).
 *
 * The browser cannot start a program, so it asks the engine to
 * (`editor/open`): VS Code or the editor in the person's settings, at the
 * line. When there is none — no `code` on the PATH, a path the Windows
 * launcher cannot take, a remote browser on another machine than the
 * engine's — the answer says why and the file opens in the client's own
 * viewer at that line instead (components/FileViewer), so a click always
 * shows the code.
 *
 * One function for every place that opens a file — the Code map, file
 * cards in answers (shared/ui/rich/Files reaches it through
 * `window.aicoOpenFile`) — and an event the app shell listens to for the
 * viewer, so none of them needs to own a modal.
 *
 * @module web/file-open
 */

import { api } from './api';

export interface ViewRequest {
  file: string;
  project?: string;
  line?: number;
  /** Why it is the viewer and not the editor, said once at the top. */
  reason?: string;
}

export const VIEW_FILE_EVENT = 'aico:view-file';

/** Show a file in the client's viewer. */
export function viewFile(req: ViewRequest): void {
  window.dispatchEvent(new CustomEvent<ViewRequest>(VIEW_FILE_EVENT, { detail: req }));
}

/**
 * The person's editor if the engine can start it, else the viewer. Resolves
 * to a line a client can flash ("Opened in VS Code"), or undefined when the
 * viewer opened.
 */
export async function openFile(file: string, line?: number, project?: string): Promise<string | undefined> {
  try {
    const r = await api.openInEditor(file, line, project);
    if (r.opened) return `Opened in ${r.editor ?? 'your editor'}${line ? ` at line ${line}` : ''}`;
    viewFile({ file, ...(project ? { project } : {}), ...(line ? { line } : {}), ...(r.reason ? { reason: r.reason } : {}) });
  } catch (err) {
    viewFile({ file, ...(project ? { project } : {}), ...(line ? { line } : {}), reason: err instanceof Error ? err.message : String(err) });
  }
  return undefined;
}

/** Make `openFile` reachable from shared widgets (they import nothing from the web client). */
export function registerFileOpener(): void {
  (window as unknown as { aicoOpenFile?: (abs: string, line?: number) => void }).aicoOpenFile = (abs, line) => { void openFile(abs, line); };
}

/** Lines of a text, numbered, with the target's index — the viewer's pure part. */
export function numbered(text: string, target?: number): { lines: string[]; width: number; index: number } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const index = target && target >= 1 ? Math.min(target, lines.length) - 1 : -1;
  return { lines, width: String(lines.length).length, index };
}
