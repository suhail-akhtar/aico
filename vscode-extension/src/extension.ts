/**
 * aico in VS Code.
 *
 * The extension is deliberately thin. aico's server already owns runs, survives
 * a closed tab, and ships a complete web workspace; reimplementing any of that
 * natively would duplicate thousands of lines to land somewhere worse. So this
 * does three things the web client cannot do for itself:
 *
 * - starts and stops the server against the open folder;
 * - turns the current selection into a question, with the file and line numbers
 *   attached, so the agent is not asked to guess what "this" refers to;
 * - surfaces background work in the status bar, so a run started an hour ago is
 *   visible without opening anything.
 *
 * @module extension
 */

import * as vscode from 'vscode';
import { ServerManager } from './server';
import { WorkspacePanel } from './panel';
import { StatusBar } from './status';

/**
 * Activated on `onStartupFinished`, not on first command.
 *
 * A command-only activation looks cheaper and is wrong here: the status bar is
 * the whole reason to prefer an extension over a browser bookmark, and it
 * cannot report a scheduled job that failed overnight if nothing has woken it.
 *
 * Waking costs nothing, because it does not start a server. `StatusBar.refresh`
 * returns immediately while none is running, so an editor opened on an
 * unrelated project pays one no-op timer and shows nothing.
 */
export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('aico');
  const server = new ServerManager(output);
  const status = new StatusBar(server);

  context.subscriptions.push(output, server, status);

  /**
   * Bring the server up, reporting failure once and clearly.
   *
   * Every command routes through this rather than calling `ensure` directly, so
   * a missing binary produces one actionable message with a way to fix it —
   * instead of an unhandled rejection in a log nobody opens.
   */
  const ready = async (): Promise<ReturnType<ServerManager['current']>> => {
    const autoStart = vscode.workspace.getConfiguration('aico').get<boolean>('autoStart', true);
    if (!server.current() && !autoStart) {
      const choice = await vscode.window.showInformationMessage(
        'aico is not running. Start it for this folder?', 'Start', 'Cancel',
      );
      if (choice !== 'Start') return undefined;
    }
    try {
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Starting aico…' },
        () => server.ensure(),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const choice = await vscode.window.showErrorMessage(`aico: ${message}`, 'Show Log');
      if (choice === 'Show Log') output.show(true);
      return undefined;
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('aico.open', async () => {
      const running = await ready();
      if (running) {
        WorkspacePanel.show(running);
        status.refresh();
      }
    }),

    vscode.commands.registerCommand('aico.newSession', async () => {
      const running = await ready();
      if (!running) return;
      // A fresh id in the client's own format. Generated here rather than asked
      // for, because the server has no notion of an empty session until
      // something is submitted to one.
      WorkspacePanel.show(running, `web-${Math.random().toString(36).slice(2, 10)}`);
    }),

    vscode.commands.registerCommand('aico.askAboutSelection', () => askAboutSelection(server, ready)),

    vscode.commands.registerCommand('aico.stopServer', () => {
      server.stop();
      WorkspacePanel.dispose();
      status.refresh();
      vscode.window.showInformationMessage('aico server stopped.');
    }),

    vscode.commands.registerCommand('aico.openInBrowser', async () => {
      const running = await ready();
      if (running) await vscode.env.openExternal(vscode.Uri.parse(running.url));
    }),

    vscode.commands.registerCommand('aico.showOutput', () => output.show(true)),
  );

  status.start();
}

/**
 * Turn the selection into a question the agent can answer without guessing.
 *
 * The context is the point. "Explain this" with no file, no line numbers and no
 * code sends the agent hunting through the repository for something the user
 * was already looking at — several tool calls to rediscover what the editor
 * knew all along.
 */
async function askAboutSelection(
  server: ServerManager,
  ready: () => Promise<ReturnType<ServerManager['current']>>,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showWarningMessage('Select some code first.');
    return;
  }

  const question = await vscode.window.showInputBox({
    prompt: 'What should aico do with this selection?',
    placeHolder: 'Explain this / find the bug / add tests for it',
    ignoreFocusOut: true,
  });
  // Undefined means escape, which is a cancellation. An empty string means the
  // user pressed enter with nothing typed, which is also not a question.
  if (!question?.trim()) return;

  const running = await ready();
  if (!running) return;

  const document = editor.document;
  const selection = editor.selection;
  const relative = vscode.workspace.asRelativePath(document.uri, false);
  const from = selection.start.line + 1;
  const to = selection.end.line + 1;
  const where = from === to ? `line ${from}` : `lines ${from}-${to}`;
  const language = document.languageId;

  const task = [
    question.trim(),
    '',
    `Context — \`${relative}\`, ${where}:`,
    '',
    '```' + language,
    document.getText(selection),
    '```',
  ].join('\n');

  // One session per file, so asking three questions about the same module
  // continues a conversation rather than starting three that each rediscover
  // the same context. Non-word characters are collapsed because the id travels
  // in a URL and is validated at the other end.
  const sessionId = `web-vsc-${relative.replace(/[^a-zA-Z0-9]+/g, '-').slice(-40)}`.toLowerCase();

  try {
    await server.api('submit', {
      method: 'POST',
      body: {
        sessionId,
        task,
        project: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      },
    });
  } catch (err) {
    vscode.window.showErrorMessage(
      `aico could not accept that: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  WorkspacePanel.show(running, sessionId);
}

export function deactivate(): void {
  // Everything is registered in `context.subscriptions`, including the server
  // manager, so VS Code disposes it. Left here explicitly because an extension
  // that leaks a child process leaves an agent running with nothing watching.
}
