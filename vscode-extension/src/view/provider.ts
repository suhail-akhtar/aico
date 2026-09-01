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
import { EditorContextSource, type EditorContext } from '../context/editor';
import { find, type FindResult } from '../context/find';
import { askPermission, type PermissionRequest } from './permission';
import { applyEdit, type EditRequest } from './apply-edit';

/** Keys in `workspaceState`. Per folder, which is what makes them useful. */
const LAST_SESSION = 'aico.lastSession';
const LAST_MODEL = 'aico.lastModel';

/** Whether this editor can host the panel beside Chat. See `vscode-version`. */
export function supportsSecondarySidebar(version = vscode.version): boolean {
  return supports(version);
}

/** Messages the host sends the panel that are not tunnel traffic. */
type HostMessage =
  | {
    t: 'boot'; folder: string | null; folderName: string | null; version: string;
    /** The conversation this folder was last on, and the model it was using. */
    lastSession: string | null; lastModel: string | null;
  }
  | { t: 'ask'; text: string; send: boolean }
  | { t: 'new-session' }
  | { t: 'focus-composer' }
  | { t: 'context'; context: EditorContext }
  | { t: 'find:result'; id: number; results: FindResult[] }
  | { t: 'permission:decided'; id: string; allow: boolean }
  | { t: 'edit:done'; id: string; applied: boolean; reason?: string };

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

  /**
   * Watches the editor, and only while the panel can see it.
   *
   * Created on `resolveWebviewView` and disposed with the view. A source that
   * outlived the panel would keep four event subscriptions alive to compute
   * payloads nobody receives, for the whole life of the window.
   */
  private editorContext: EditorContextSource | undefined;

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

  /**
   * Reveal the panel and put the caret in the composer.
   *
   * The editor context is pushed alongside rather than left to the watcher's
   * next event. Revealing a view does not change the selection, so nothing would
   * fire — and the chip for the code you just highlighted would be missing at
   * exactly the moment you pressed a key to ask about it.
   */
  async focusComposer(): Promise<void> {
    await this.reveal();
    this.editorContext?.push();
    this.send({ t: 'focus-composer' });
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

    const editorContext = new EditorContextSource((context) => {
      this.send({ t: 'context', context });
    });
    this.editorContext = editorContext;

    view.webview.onDidReceiveMessage((message: TunnelRequest | {
      t: string; id?: number; query?: string; uri?: string; line?: number;
    }) => {
      if (message?.t === 'http') { void tunnel.handle(message as TunnelRequest); return; }
      if (message?.t === 'http:abort' && typeof message.id === 'number') {
        tunnel.abort(message.id); return;
      }
      if (message?.t === 'ready') { this.onReady(); return; }

      if (message?.t === 'find' && typeof message.id === 'number') {
        const id = message.id;
        void find(message.query ?? '')
          .then(results => this.send({ t: 'find:result', id, results }))
          // A failed search answers with nothing rather than leaving the menu
          // spinning for ever on a promise that will not settle.
          .catch(() => this.send({ t: 'find:result', id, results: [] }));
        return;
      }

      /*
        Opening a file from a chip. Worth having because a context chip names
        something you may want to look at before asking about it, and switching
        to the Explorer to find it again is the errand this feature exists to
        remove.
      */
      if (message?.t === 'reveal' && typeof message.uri === 'string') {
        const uri = vscode.Uri.parse(message.uri);
        const line = typeof message.line === 'number' ? message.line - 1 : undefined;
        void vscode.window.showTextDocument(uri, {
          preview: true,
          ...(line === undefined ? {} : {
            selection: new vscode.Range(line, 0, line, 0),
          }),
        }).then(undefined, () => { /* deleted, or not a text file */ });
        return;
      }

      if (message?.t === 'open-workspace') {
        void vscode.commands.executeCommand('aico.open'); return;
      }
      /*
        There is nothing to work in, so offer the one thing that fixes it.

        aico needs a directory — a session's log is filed under one and its file
        tools are confined to it. Saying "open a folder" and leaving the reader
        to go and find the menu is a worse version of the same answer.
      */
      if (message?.t === 'open-folder') {
        void vscode.commands.executeCommand('vscode.openFolder');
        return;
      }

      /*
        A tool call the run is blocked on.

        Asked here rather than drawn in the panel so it behaves like every other
        decision VS Code puts to a person: modal, focused, and impossible to
        scroll past while a turn waits on it.
      */
      if (message?.t === 'permission') {
        const request = (message as unknown as { request: PermissionRequest }).request;
        if (!request?.id) return;
        void askPermission(request).then(allow => {
          this.send({ t: 'permission:decided', id: request.id, allow });
        });
        return;
      }

      /*
        A file write the run handed over. Applied as a WorkspaceEdit so it
        enters the undo stack and Source Control rather than arriving as an
        external change nobody in the editor asked for.
      */
      if (message?.t === 'edit') {
        const request = (message as unknown as { request: EditRequest }).request;
        if (!request?.id) return;
        void applyEdit(request).then(outcome => {
          this.send({
            t: 'edit:done',
            id: request.id,
            applied: outcome.applied,
            ...(outcome.reason ? { reason: outcome.reason } : {}),
          });
        });
        return;
      }

      /*
        Remember where this folder is, so reopening the panel resumes rather
        than restarts.

        Without it the panel minted a fresh session on every load — losing the
        conversation, and with it the model pinned to that session, which is
        stored per session by design. The symptom was "it forgets my model";
        the cause was that it forgot the session the model was pinned to.
      */
      if (message?.t === 'remember') {
        const remember = message as unknown as { sessionId?: string; model?: string | null };
        if (typeof remember.sessionId === 'string') {
          void this.context.workspaceState.update(LAST_SESSION, remember.sessionId);
        }
        if (remember.model !== undefined) {
          void this.context.workspaceState.update(LAST_MODEL, remember.model ?? undefined);
        }
        return;
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
      editorContext.dispose();
      this.tunnel = undefined;
      this.editorContext = undefined;
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
      /*
        Where this folder left off.

        `workspaceState` rather than `globalState`, because both answers are
        per-project: the conversation belongs to this repository, and so does
        the model somebody chose for working in it.
      */
      lastSession: this.context.workspaceState.get<string>(LAST_SESSION) ?? null,
      lastModel: this.context.workspaceState.get<string>(LAST_MODEL) ?? null,
    });
    const queued = this.pending;
    this.pending = [];
    for (const message of queued) this.send(message);

    /*
      The editor's state, once, immediately.

      The source only speaks when something *changes*, and nothing changes while
      a person looks at a panel they have just opened. Without this the chips are
      empty until the next keystroke — which reads as the feature not working
      rather than as it waiting.
    */
    this.editorContext?.push();
  }

  private send(message: HostMessage): void {
    if (!this.view) { this.pending.push(message); return; }
    void this.view.webview.postMessage(message);
  }

  dispose(): void {
    this.tunnel?.abortAll();
    this.editorContext?.dispose();
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
