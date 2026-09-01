/**
 * Applying the agent's file writes the way a person's own edits are applied.
 *
 * A file changed behind VS Code's back is an *external* change: `Ctrl+Z` cannot
 * take it back, an open buffer reloads rather than edits, and there is no point
 * at which it could have been reviewed. A `WorkspaceEdit` is the same change
 * arriving through the front door — it joins the undo stack, participates in the
 * editor's own diff machinery, and behaves like something that happened *in*
 * the editor because it did.
 *
 * ## Three decisions worth stating
 *
 * **The document is the truth, not the disk.** The "before" is read from the
 * open document when there is one, so an unsaved buffer is edited rather than
 * clobbered. Reading the disk instead would silently discard whatever the user
 * had typed and not yet saved.
 *
 * **The edit is trimmed to what actually changed.** Replacing the whole file
 * works and is one line, and produces an undo entry that reverts everything and
 * a diff that claims every line moved. A common prefix and suffix are cheap to
 * compute and turn that into an edit the size of the change.
 *
 * **It is saved afterwards.** Leaving it dirty would be a nicer review
 * experience and a correctness bug: the engine's next `Read` goes to disk, and
 * a buffer that disagrees with the file is how an agent reasons about content
 * that is not there. Saving does not cost the undo — VS Code's stack survives
 * it — so the change is still one `Ctrl+Z` away.
 *
 * @module view/apply-edit
 */

import * as vscode from 'vscode';
import { changedSpan } from './text-span';

export interface EditRequest {
  id: string;
  path: string;
  after: string;
}

export interface EditOutcome {
  applied: boolean;
  reason?: string;
}

export async function applyEdit(request: EditRequest): Promise<EditOutcome> {
  const uri = vscode.Uri.file(request.path);

  try {
    const existing = await open(uri);

    if (!existing) {
      /*
        A new file. `createFile` with `contents` does both halves in one
        workspace edit, so the creation and its content are a single undo step
        rather than an empty file followed by a write.
      */
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(uri, {
        contents: Buffer.from(request.after, 'utf8'),
        ignoreIfExists: false,
      });
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) return { applied: false, reason: 'VS Code refused to create the file' };
      // Created files are written by `createFile` itself; opening and saving is
      // what makes the buffer and the disk agree from this point on.
      const created = await vscode.workspace.openTextDocument(uri);
      if (created.isDirty) await created.save();
      // A new file is worth showing for the same reason a changed one is, and
      // more so: nothing else in the editor hints that it now exists.
      void vscode.window.showTextDocument(created, { preview: true, preserveFocus: true })
        .then(undefined, () => { /* created regardless */ });
      return { applied: true };
    }

    const before = existing.getText();
    if (before === request.after) return { applied: true };

    const span = changedSpan(before, request.after);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      uri,
      new vscode.Range(existing.positionAt(span.start), existing.positionAt(span.end)),
      span.text,
    );

    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      // A read-only file, a failed formatter, a refusing extension. The model
      // is told, and can try a different route.
      return { applied: false, reason: 'VS Code did not apply the edit' };
    }

    /*
      Show the file it just changed.

      Copilot and Cursor both do this, and it is not decoration: an agent that
      edits six files while you read prose leaves you no idea which ones moved,
      and `Ctrl+Z` is only useful if you are looking at the buffer it applies to.

      `preview: true` reuses the italic preview tab rather than accumulating six
      permanent ones, and `preserveFocus` keeps the caret in the panel — the
      reader is mid-conversation, and stealing focus to a file they did not ask
      to edit is worse than not showing it.
    */
    void vscode.window.showTextDocument(existing, {
      preview: true,
      preserveFocus: true,
      selection: new vscode.Range(
        existing.positionAt(span.start), existing.positionAt(span.start),
      ),
    }).then(undefined, () => { /* a file the editor will not show is still edited */ });

    const saved = await existing.save();
    if (!saved) {
      /*
        Applied but not saved is the worst of the three states: the buffer has
        the change and disk does not, so the engine's next read disagrees with
        what the editor shows. Reported as a failure so nothing downstream
        assumes the file is on disk.
      */
      return { applied: false, reason: 'the edit was applied but the file could not be saved' };
    }
    return { applied: true };
  } catch (err) {
    return { applied: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** The open document, or undefined when the file does not exist yet. */
async function open(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  try {
    return await vscode.workspace.openTextDocument(uri);
  } catch {
    return undefined;
  }
}
