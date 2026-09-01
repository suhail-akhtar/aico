/**
 * Asking permission the way the editor asks for things.
 *
 * A modal, not a card in the panel. The distinction matters more than it looks:
 * a card can be scrolled past, sits behind whichever view has focus, and is
 * invisible the moment the panel is hidden — while the turn is *blocked* the
 * whole time, waiting on a question nobody has been shown. VS Code's own modal
 * takes focus, dims the workbench, and cannot be missed.
 *
 * ## Deny is the default, and it is the safe one
 *
 * `showWarningMessage` resolves `undefined` when dismissed with Escape or by
 * clicking away. That is treated as a refusal. The alternative — allowing on
 * dismissal — would mean a stray keypress runs a shell command, and the whole
 * point of the prompt is that this decision is deliberate.
 *
 * @module view/permission
 */

import * as vscode from 'vscode';

export interface PermissionRequest {
  id: string;
  tool: string;
  detail: string;
  fileDiff?: { path: string; added?: string[]; removed?: string[]; preview?: string };
}

/** Tools whose name alone does not say what is about to happen. */
const VERB: Record<string, string> = {
  Terminal: 'run a command',
  Bash: 'run a command',
  Write: 'write a file',
  Edit: 'edit a file',
  MultiEdit: 'edit a file',
  NotebookEdit: 'edit a notebook',
  WebFetch: 'fetch a URL',
  WebSearch: 'search the web',
  Task: 'delegate to a sub-agent',
};

/**
 * Put the decision in front of the user and return it.
 *
 * Returns `false` for anything that is not an explicit allow, including a
 * dismissed dialog and a failure to show one at all.
 */
export async function askPermission(request: PermissionRequest): Promise<boolean> {
  const verb = VERB[request.tool] ?? `use ${request.tool}`;

  /*
    The detail goes in `detail`, not in the headline.

    A modal's main message is rendered large and bold and does not wrap kindly;
    a 100-character shell command in it is unreadable. VS Code's `detail` is the
    right place for the thing being decided, and it is the part people actually
    read before clicking.
  */
  const detail = describe(request);

  const choice = await vscode.window.showWarningMessage(
    `aico wants to ${verb}.`,
    { modal: true, detail },
    'Allow',
  );

  // `undefined` is Escape, clicking away, or Cancel. All three mean no.
  return choice === 'Allow';
}

function describe(request: PermissionRequest): string {
  const lines: string[] = [];

  if (request.detail) lines.push(request.detail);

  /*
    A diff, when there is one to show.

    The engine already builds a preview for the write tools, and allowing an
    edit without seeing it is barely a decision at all. Bounded hard: a modal
    that grows past the window is a modal whose buttons are off-screen.
  */
  const diff = request.fileDiff;
  if (diff) {
    if (diff.preview) lines.push(diff.preview);
    for (const line of (diff.removed ?? []).slice(0, 4)) lines.push(`- ${line}`);
    for (const line of (diff.added ?? []).slice(0, 6)) lines.push(`+ ${line}`);
  }

  lines.push('');
  lines.push('Deny is the default — dismissing this refuses.');
  return lines.join('\n');
}
