/**
 * "Open in external editor" in the desktop: the person's own editor (VS Code,
 * or `editor.command` in their settings) at a file and line, started by the
 * engine (server/editor, ADR 0030).
 *
 * The desktop has its own editor; this is the way out of it, for when the
 * person wants the file where they normally work. The request carries the
 * desktop's one-time "a person did this" grant (electron/protocol
 * HUMAN_ROUTES), so a launch only ever follows a click in the AICO window.
 *
 * @module desktop/renderer/lib/external-editor
 */

import { api } from '@web/api';

/** Resolves to what to tell the person; rejects with why no editor opened. */
export async function openExternal(root: string, file: string, line?: number): Promise<string> {
  const r = await api.openInEditor(file, line, root);
  if (!r.opened) throw new Error(r.reason ?? 'No external editor could be opened.');
  return `Opened in ${r.editor ?? 'your editor'}${line ? ` at line ${line}` : ''}`;
}
