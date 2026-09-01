/**
 * Who actually puts bytes on disk.
 *
 * Every write tool used to call `fs.writeFile` directly, which is correct in a
 * terminal and wrong inside an editor. A file changed underneath VS Code is an
 * *external* change: it does not enter the undo stack, so `Ctrl+Z` cannot take
 * it back; it arrives in an open buffer as a reload rather than an edit; and
 * there is no moment at which it could have been reviewed.
 *
 * So a run may carry a writer, and the write tools ask for it rather than
 * assuming. When one is attached — the VS Code panel attaches one — the change
 * is applied as a `WorkspaceEdit` and lands the way a person's own edit does.
 * When none is, the fallback is exactly what the code did before, which is what
 * keeps the terminal, the browser workspace and every headless run unchanged.
 *
 * ## Refusal is an outcome, not an error to swallow
 *
 * A writer can decline — the reviewer pressed Undo, the file is read-only, the
 * editor said no. That has to reach the model as a failed tool call so it can
 * react, which is why `commitFile` throws on refusal rather than returning
 * quietly. A silent success would leave the model believing a file it never
 * wrote, and every later step reasoning about content that is not there.
 *
 * @module tools/file-writer
 */

import { writeFile as fsWriteFile, mkdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { currentRunContext } from '../run-context.js';

export interface EditRequest {
  /** Absolute, already resolved inside the workspace by the caller. */
  path: string;
  /** The file as it was, or null when it did not exist. */
  before: string | null;
  after: string;
}

export interface EditOutcome {
  applied: boolean;
  /** Why not, in words a model can act on. Present when `applied` is false. */
  reason?: string;
}

export type FileWriter = (edit: EditRequest) => Promise<EditOutcome>;

/**
 * Refused by whoever was asked to apply it.
 *
 * A named class so the tool layer can tell "the user said no" — a legitimate
 * answer the model should adapt to — from a disk error, which is a fault.
 */
export class EditRefused extends Error {
  constructor(readonly file: string, reason?: string) {
    super(reason
      ? `The edit to ${file} was not applied: ${reason}`
      : `The edit to ${file} was not applied.`);
    this.name = 'EditRefused';
  }
}

/**
 * Write `content` to `resolved`, through the run's writer if it has one.
 *
 * `previous` is passed in rather than read here because the callers already
 * have it: `Edit` read the file to find the string it replaced, and re-reading
 * would open a window in which the two disagree.
 */
export async function commitFile(
  resolved: string,
  content: string,
  previous?: string | null,
): Promise<void> {
  const writer = currentRunContext()?.applyEdit;

  if (!writer) {
    await mkdir(path.dirname(resolved), { recursive: true });
    await fsWriteFile(resolved, content, 'utf8');
    return;
  }

  /*
    The writer is told what the file was, so it can apply a *diff* rather than
    replace the document wholesale. Replacing everything works, and produces an
    undo entry that reverts the entire file and a Source Control diff that
    claims every line changed.
  */
  const before = previous !== undefined
    ? previous
    : (existsSync(resolved) ? await readFile(resolved, 'utf8') : null);

  const outcome = await writer({ path: resolved, before, after: content });
  if (!outcome.applied) throw new EditRefused(resolved, outcome.reason);
}
