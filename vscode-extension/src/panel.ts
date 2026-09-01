/**
 * The aico workspace, inside a VS Code panel.
 *
 * This embeds the web client rather than reimplementing it. aico already ships
 * a complete workspace — sessions, tool cards with diffs, plan and task panels,
 * trajectory, Mini Apps — and rebuilding that natively would duplicate several
 * thousand lines to arrive somewhere worse.
 *
 * ## Why an iframe inside the webview
 *
 * A webview cannot load a remote document as its own top-level content, so the
 * localhost app goes in an iframe and the webview holds only the shell.
 *
 * Two things make this work at all, and both are luck rather than design:
 *
 * 1. **Port mapping only handles http and https.** A `ws://` connection cannot
 *    be mapped, so an app built on WebSockets could not be embedded this way.
 *    aico's client streams over `fetch` with a reader — chosen originally
 *    because `EventSource` cannot send headers — which happens to be exactly
 *    what survives the proxy.
 *
 * 2. **The server's Origin guard passes untouched.** It refuses any request
 *    whose `Origin` is not its own loopback address. The iframe's document
 *    origin *is* `http://localhost:<port>`, so its requests are same-origin and
 *    the guard never fires. Embedding therefore needs no weakening of it, which
 *    was the thing worth checking before writing any of this.
 *
 * @module panel
 */

import * as vscode from 'vscode';
import type { RunningServer } from './server';

export class WorkspacePanel {
  private static current: WorkspacePanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposed = false;

  static show(server: RunningServer, sessionId?: string, settings?: boolean): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (WorkspacePanel.current && !WorkspacePanel.current.disposed) {
      WorkspacePanel.current.panel.reveal(column, true);
      // Reload only when pointed at a different conversation. Reloading on
      // every reveal would throw away scroll position and any half-typed
      // message every time the status bar was clicked.
      if (sessionId || settings) WorkspacePanel.current.load(server, sessionId, settings);
      return;
    }

    WorkspacePanel.current = new WorkspacePanel(server, column, sessionId, settings);
  }

  static dispose(): void {
    WorkspacePanel.current?.panel.dispose();
    WorkspacePanel.current = undefined;
  }

  private constructor(
    server: RunningServer, column: vscode.ViewColumn,
    sessionId?: string, settings?: boolean,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'aico.workspace',
      'aico',
      { viewColumn: column, preserveFocus: true },
      {
        enableScripts: true,
        // Without this the app is torn down and reloaded every time the tab
        // loses focus, which for a long-running turn means losing the view of
        // it repeatedly.
        retainContextWhenHidden: true,
        /*
          Map the port to itself.

          Recommended even when the two numbers are equal: locally it is a
          no-op, but over Remote SSH or a Codespace `localhost` inside a webview
          means the *user's* machine rather than the host the server is on, and
          without the mapping the panel would quietly show nothing.
        */
        portMapping: [{ webviewPort: server.port, extensionHostPort: server.port }],
      },
    );

    this.panel.onDidDispose(() => {
      this.disposed = true;
      WorkspacePanel.current = undefined;
    });

    this.load(server, sessionId, settings);
  }

  load(server: RunningServer, sessionId?: string, settings?: boolean): void {
    const target = new URL(`http://localhost:${server.port}/`);
    target.searchParams.set('token', server.token);
    if (sessionId) target.searchParams.set('session', sessionId);
    /*
      Straight to the settings screens.

      The panel's gear used to open VS Code's own settings page, which shows
      this extension's five properties and nothing about providers, models,
      MCP, skills or memory — the eight panes people actually mean by
      "settings". Rebuilding those in a 300px column would be the wrong shape
      for every one of them; opening the real ones in an editor tab is the
      right width and one click.
    */
    if (settings) target.searchParams.set('settings', '1');
    this.panel.webview.html = shell(target.toString(), server.port);
  }
}

/**
 * The webview document: a full-bleed iframe and nothing else.
 *
 * The CSP is explicit rather than omitted. A webview with `enableScripts` and
 * no policy will happily frame anything, and this one only ever needs to frame
 * one loopback port — narrowing it costs a line and removes the question.
 */
function shell(src: string, port: number): string {
  const allowed = `http://localhost:${port} http://127.0.0.1:${port}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${allowed}; style-src 'unsafe-inline';">
<style>
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
  iframe { border: 0; width: 100%; height: 100%; display: block; }
</style>
</head>
<body>
  <iframe src="${escapeAttr(src)}" allow="clipboard-read; clipboard-write"></iframe>
</body>
</html>`;
}

/** The URL carries a token, so it is escaped rather than interpolated raw. */
function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
