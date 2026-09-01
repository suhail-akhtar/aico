/**
 * aico in VS Code.
 *
 * The engine is not reimplemented here and never will be: aico's server owns the
 * runs, survives a closed window, and replays a session from its event log. What
 * the extension owns is everything that only makes sense inside an editor.
 *
 * - a panel of its own, beside Chat, drawn natively rather than embedded;
 * - the server's lifecycle, against the folder that is actually open;
 * - the current selection as a question, with its file and line numbers, so the
 *   agent is not asked to guess what "this" refers to;
 * - background work in the status bar, so a run started an hour ago is visible
 *   without opening anything.
 *
 * The full web workspace is still reachable in a tab. It is better than a 300px
 * column at the things that want width — Mini Apps, the trajectory view, the
 * whole settings surface — and worse at being an editor panel, which is why both
 * exist.
 *
 * @module extension
 */

import * as vscode from 'vscode';
import { ServerManager } from './server';
import { WorkspacePanel } from './panel';
import { StatusBar } from './status';
import { AicoViewProvider, supportsSecondarySidebar } from './view/provider';

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

  /*
    Which side bar the panel lives in, decided before any view resolves.

    Both containers are declared in the manifest and each is gated on this key,
    so exactly one is ever real. It has to be set here rather than left to
    default, because an unset context key is falsy — which would silently put
    every user on the Secondary Side Bar branch, including the ones whose VS Code
    does not have one.
  */
  void vscode.commands.executeCommand(
    'setContext', 'aico:noSecondarySidebar', !supportsSecondarySidebar(),
  );

  const panel = new AicoViewProvider(context, server, output);
  context.subscriptions.push(
    panel,
    /*
      Registered under both ids.

      Only one container exists at a time, so only one of these ever resolves —
      but which one is not known until the context key above has been applied,
      and a view whose provider was never registered renders as a permanently
      empty pane with no error anywhere.

      `retainContextWhenHidden` is the expensive option and the right one: the
      panel holds a live SSE subscription to a running agent, and a webview that
      is torn down when you switch to the Explorer would drop it and reconnect —
      replaying the session from its log on every glance at the file tree.
    */
    vscode.window.registerWebviewViewProvider(AicoViewProvider.PRIMARY_ID, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(AicoViewProvider.SECONDARY_ID, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

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
    vscode.commands.registerCommand('aico.focus', () => panel.reveal()),

    vscode.commands.registerCommand('aico.open', async () => {
      const running = await ready();
      if (running) {
        WorkspacePanel.show(running);
        status.refresh();
      }
    }),

    /*
      A new session belongs to the panel now.

      It used to open the workspace tab on a freshly minted id, which was the
      only surface there was. The panel owns its own session list and mints ids
      in the same format, so asking it is both simpler and correct — the tab
      would otherwise start a *second* conversation beside the one on screen.
    */
    vscode.commands.registerCommand('aico.newSession', () => panel.newSession()),

    vscode.commands.registerCommand('aico.askAboutSelection', () => askAboutSelection(panel)),

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

    /*
      Prove the extension is alive.

      Added because the first failure was invisible: the extension was installed
      but the window predated it, so nothing had loaded it and every keypress
      did nothing. From inside the editor that is indistinguishable from a
      broken extension, and there was no way to tell them apart.

      If this command is missing from the palette, the window needs reloading.
      If it runs, the answer it gives says what is actually wrong.
    */
    vscode.commands.registerCommand('aico.doctor', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const running = server.current();
      const lines = [
        `Extension: v${context.extension.packageJSON.version as string} — loaded and running.`,
        `Folder: ${folder ?? 'none open — aico needs a folder to work in.'}`,
        `Server: ${running ? `running on port ${running.port}` : 'not started yet'}`,
        `Command: ${vscode.workspace.getConfiguration('aico').get<string>('command', 'aico')}`,
      ];

      if (!running) {
        lines.push('', 'Starting it now to check it works…');
        output.appendLine(lines.join('\n'));
        const started = await ready();
        output.appendLine(started
          ? `OK — server started on port ${started.port}.`
          : 'FAILED — see the error above.');
      } else {
        output.appendLine(lines.join('\n'));
      }
      output.show(true);
    }),
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
async function askAboutSelection(panel: AicoViewProvider): Promise<void> {
  /*
    Answer the keypress even when there is nothing to act on.

    The keybinding used to be gated on `editorHasSelection`, which meant
    pressing it with no selection did *nothing at all* — no message, no hint,
    no way to tell a missing selection from a broken extension. That is exactly
    how it failed the first time somebody tried it.

    So the binding fires whenever the editor has focus, and the reason lives
    here where it can be said out loud.
  */
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('aico: open a file and select some code first.');
    return;
  }
  if (editor.selection.isEmpty) {
    vscode.window.showWarningMessage(
      'aico: select the code you want to ask about, then press it again.',
    );
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

  /*
    It goes to the conversation on screen, not to a session of its own.

    This used to mint one session per file, so that three questions about the
    same module continued one conversation. The panel changes what the right
    answer is: there is now a visible current conversation, and quietly sending a
    question somewhere else — while the panel carries on showing something else
    entirely — is indistinguishable from the question being lost.

    Continuity is still there, and better than it was: the panel keeps the
    session it was on, so the follow-up lands in the same place the first
    question did without anyone having to name a session for it.
  */
  await panel.ask(task, true);
}

export function deactivate(): void {
  // Everything is registered in `context.subscriptions`, including the server
  // manager, so VS Code disposes it. Left here explicitly because an extension
  // that leaks a child process leaves an agent running with nothing watching.
}
