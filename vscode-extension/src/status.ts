/**
 * Background work, in the status bar.
 *
 * This is the piece that justifies a native extension over a bookmark. A run
 * started an hour ago, a scheduled job that failed overnight, a dev server the
 * agent left up — none of those are visible unless you go and look, and the
 * whole point of the work ledger is that you should not have to.
 *
 * It reads `/api/system`, which already carries the ledger: every agent,
 * process, schedule and watcher in one list, live and recently settled.
 *
 * @module status
 */

import * as vscode from 'vscode';
import type { ServerManager } from './server';

/** Ledger states nothing further happens from. Mirrors the server's set. */
const SETTLED = new Set(['done', 'failed', 'cancelled', 'lost']);

const POLL_MS = 4000;

interface WorkRow {
  id: string;
  kind: string;
  title: string;
  state: string;
  origin: string;
  reported: boolean;
  outcome?: string;
}

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly server: ServerManager) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'aico.open';
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.refresh(); }, POLL_MS);
    void this.refresh();
  }

  /**
   * Read the ledger and say the shortest true thing about it.
   *
   * Silent when the server is not running: an extension that permanently
   * occupies status-bar space to report nothing is one people disable.
   */
  async refresh(): Promise<void> {
    if (!vscode.workspace.getConfiguration('aico').get<boolean>('statusBar', true)) {
      this.item.hide();
      return;
    }
    if (!this.server.current()) {
      this.item.hide();
      return;
    }

    let work: WorkRow[];
    try {
      const system = await this.server.api<{ work?: WorkRow[] }>('system');
      work = system.work ?? [];
    } catch {
      // A failed poll is not worth a message. The server may be restarting, and
      // an error toast every four seconds would be its own problem.
      this.item.hide();
      return;
    }

    const live = work.filter(w => !SETTLED.has(w.state));
    // Only what has not been acknowledged — the same rule the panel uses, so
    // the two never disagree about whether something still needs attention.
    const unread = work.filter(w => SETTLED.has(w.state) && !w.reported);
    const failed = unread.filter(w => w.state === 'failed' || w.state === 'lost');

    if (!live.length && !unread.length) {
      this.item.text = '$(sparkle) aico';
      this.item.tooltip = 'aico is running. Nothing in the background.';
      this.item.backgroundColor = undefined;
      this.item.show();
      return;
    }

    const parts: string[] = [];
    if (live.length) parts.push(`${live.length} running`);
    if (unread.length) parts.push(`${unread.length} finished`);
    this.item.text = `$(sparkle) aico: ${parts.join(', ')}`;

    // Failure is the one state worth colouring. Warning rather than error,
    // because a failed background job is information, not an emergency — and a
    // status bar that goes red for routine outcomes stops meaning anything.
    this.item.backgroundColor = failed.length
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;

    this.item.tooltip = new vscode.MarkdownString(
      [
        ...(live.length ? ['**Running**', ...live.slice(0, 6).map(row)] : []),
        ...(unread.length ? ['', '**Finished, not yet acknowledged**', ...unread.slice(0, 6).map(row)] : []),
        '',
        '_Click to open the workspace._',
      ].join('\n\n'),
    );
    this.item.show();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.item.dispose();
  }
}

function row(w: WorkRow): string {
  const label = w.title.length > 60 ? `${w.title.slice(0, 57)}…` : w.title;
  const tag = w.origin === 'cron' ? ' _(scheduled)_'
    : w.origin === 'remote' ? ' _(over MCP)_'
      : '';
  const outcome = w.outcome ? ` — ${w.outcome.split('\n')[0].slice(0, 70)}` : '';
  return `- \`${w.state}\` ${label}${tag}${outcome}`;
}
