/**
 * The aico panel: a view of our own, beside Chat.
 *
 * This is the piece that makes the extension native rather than embedded. The
 * old panel put the entire web workspace in an iframe — a browser page wearing
 * VS Code's frame, unaware of the editor around it. This renders a purpose-built
 * UI in the webview itself, styled from the user's own theme, talking to the
 * extension host over `postMessage` and never to the network.
 *
 * The full workspace is still one click away; it is good at things a 300px
 * column is not, and the two are complementary rather than redundant.
 *
 * ## Why the manifest declares the same view twice
 *
 * `viewsContainers.secondarySidebar` — the Chat/Claude Code/Codex strip — only
 * became stable in VS Code 1.106. Declaring it on an older build does not fail
 * cleanly; it displaces *other* extensions' views (`QwenLM/qwen-code#2432`). So
 * both containers are declared and gated on a context key set at activation,
 * which is what Claude Code and Codex both do. Exactly one is ever visible.
 *
 * @module view/provider
 */

import * as vscode from 'vscode';
import type { ServerManager } from '../server';
import { HttpTunnel, type TunnelRequest, type TunnelResponse } from './http-tunnel';
import { supportsSecondarySidebar as supports } from './vscode-version';
import { canonicalFolder } from '../paths';

/** Whether this editor can host the panel beside Chat. See `vscode-version`. */
export function supportsSecondarySidebar(version = vscode.version): boolean {
  return supports(version);
}

/** Messages the host sends the panel that are not tunnel traffic. */
type HostMessage =
  | { t: 'boot'; folder: string | null; folderName: string | null; version: string }
  | { t: 'ask'; text: string; send: boolean }
  | { t: 'new-session' };

export class AicoViewProvider implements vscode.WebviewViewProvider {
  /** Both registered ids resolve to this one provider; only one ever appears. */
  static readonly PRIMARY_ID = 'aico.chat';
  static readonly SECONDARY_ID = 'aico.chatSecondary';

  private view: vscode.WebviewView | undefined;
  private tunnel: HttpTunnel | undefined;
  /**
   * Said before the panel existed, delivered once it does.
   *
   * "Ask about this selection" can fire while the view has never been opened,
   * and `resolveWebviewView` does not run until VS Code decides to show it.
   * Dropping the question would make the command silently do nothing, which is
   * precisely the failure this extension has already shipped once.
   */
  private pending: HostMessage[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly server: ServerManager,
    private readonly log: vscode.OutputChannel,
  ) {}

  /** Bring the panel into view, starting nothing else. */
  async reveal(): Promise<void> {
    if (this.view) {
      this.view.show?.(true);
      return;
    }
    const id = supportsSecondarySidebar()
      ? AicoViewProvider.SECONDARY_ID
      : AicoViewProvider.PRIMARY_ID;
    await vscode.commands.executeCommand(`${id}.focus`);
  }

  /**
   * Put a question in the panel's composer, revealing it first.
   *
   * `send: false` leaves it in the box to be edited. That is the right default
   * for context added without a question attached — dropping a hundred lines of
   * selection straight into a run is not what "add this to the chat" means.
   */
  async ask(text: string, send = false): Promise<void> {
    await this.reveal();
    this.send({ t: 'ask', text, send });
  }

  /** Start a fresh conversation in the panel. */
  async newSession(): Promise<void> {
    await this.reveal();
    this.send({ t: 'new-session' });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;

    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);

    const tunnel = new HttpTunnel(
      this.server,
      (message: TunnelResponse) => { void view.webview.postMessage(message); },
      this.log,
    );
    this.tunnel = tunnel;

    view.webview.onDidReceiveMessage((message: TunnelRequest | { t: string; id?: number }) => {
      if (message?.t === 'http') { void tunnel.handle(message as TunnelRequest); return; }
      if (message?.t === 'http:abort' && typeof message.id === 'number') {
        tunnel.abort(message.id); return;
      }
      if (message?.t === 'ready') { this.onReady(); return; }
      if (message?.t === 'open-workspace') {
        void vscode.commands.executeCommand('aico.open'); return;
      }
      if (message?.t === 'open-settings') {
        void vscode.commands.executeCommand(
          'workbench.action.openSettings', '@ext:suhail-akhtar.aico-vscode',
        );
        return;
      }
    });

    view.onDidDispose(() => {
      tunnel.abortAll();
      this.tunnel = undefined;
      this.view = undefined;
    });
  }

  /**
   * The panel has mounted and can be spoken to.
   *
   * Everything queued while it did not exist is flushed here, in order, after
   * the boot frame — a question that arrived before the panel knew which folder
   * it was working in would be answered against the wrong project.
   */
  private onReady(): void {
    const folder = vscode.workspace.workspaceFolders?.[0];
    this.send({
      t: 'boot',
      // Canonical, so the panel matches the project the server already knows
      // rather than registering a second one spelled `e:\` — see `paths.ts`.
      folder: folder ? canonicalFolder(folder.uri.fsPath) : null,
      folderName: folder?.name ?? null,
      version: this.context.extension.packageJSON.version as string,
    });
    const queued = this.pending;
    this.pending = [];
    for (const message of queued) this.send(message);
  }

  private send(message: HostMessage): void {
    if (!this.view) { this.pending.push(message); return; }
    void this.view.webview.postMessage(message);
  }

  dispose(): void {
    this.tunnel?.abortAll();
  }

  /**
   * The webview document.
   *
   * The CSP is the point of writing this by hand. `default-src 'none'` means no
   * host is reachable at all — the panel cannot make a network request even if
   * something in the bundle tried to, which is what makes tunnelling everything
   * through the host a security property rather than only a plumbing decision.
   *
   * `'strict-dynamic'` sits beside the nonce because the bundle is code-split:
   * the heavy renderers (mermaid, echarts, katex, vega) are behind dynamic
   * `import()` so a text reply never pays for them. Those chunks cannot carry a
   * nonce — nothing writes a tag for them — so trust is inherited from the module
   * that imported them instead. Without it the panel loads and looks fine until
   * the first diagram, which then simply never appears.
   */
  private html(webview: vscode.Webview): string {
    const asset = (...parts: string[]): vscode.Uri =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', ...parts));

    const nonce = nonceOf(32);

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  img-src ${webview.cspSource} data: blob:;
  font-src ${webview.cspSource};
  style-src ${webview.cspSource} 'unsafe-inline';
  script-src 'nonce-${nonce}' 'strict-dynamic';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset('panel.css')}">
<title>aico</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" type="module" src="${asset('panel.js')}"></script>
</body>
</html>`;
  }
}

/**
 * A fresh nonce per document.
 *
 * `Math.random` is not a security primitive, and this one does not need to be:
 * the nonce stops *other* content in this document from executing, and the only
 * content in this document is ours. It is regenerated per load regardless,
 * because a constant nonce in a CSP is the same as no CSP.
 */
function nonceOf(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}
