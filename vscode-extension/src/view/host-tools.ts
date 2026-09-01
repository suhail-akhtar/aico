/**
 * The editor half of the host tools.
 *
 * Three things the engine cannot do from outside VS Code, done here and reported
 * back: read the Problems panel, run a configured task, and change what the
 * window has open. The contract lives in `shared/host-tools`; this is the only
 * file that knows how any of it is actually accomplished.
 *
 * ## Everything returns rather than throws
 *
 * A tool call on the other end is blocked on this answer, so a thrown error that
 * escapes would leave the run hanging until its timeout. Every path here ends in
 * a `HostAnswer` — including the refusals, which are the interesting ones: a
 * declined folder switch has to reach the model as a *failure*, or it carries on
 * believing it changed the window.
 *
 * ## What is deliberately confined
 *
 * Relative paths resolve against the project root and are checked to stay inside
 * it. Absolute paths are allowed only for `openFolder` and `createFolder`, which
 * are the two operations whose entire purpose is to point somewhere new — and
 * both of those ask the user first. Without that split, `createFolder` with
 * `../../..` would be a path-traversal primitive wearing a friendly name.
 *
 * @module view/host-tools
 */

import * as vscode from 'vscode';
import * as path from 'path';
/*
  Declared here rather than imported from `shared/host-tools`.

  The extension host compiles to CommonJS and the repo is an ES module, so a
  type-only import across that line needs a `resolution-mode` attribute and
  breaks the build without one. These two shapes are four fields; `apply-edit`
  already makes the same trade for `EditRequest`, and the wire format is
  asserted by the live probe rather than by a shared type either way.
*/
export interface HostCall {
  id: string;
  tool: 'VSCodeDiagnostics' | 'VSCodeTasks' | 'VSCodeWorkspace';
  input: Record<string, unknown>;
}

export interface HostAnswer {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * How long to let the language server settle before reading diagnostics.
 *
 * Bounded, because the model picks this number. Asked to "wait for the type
 * checker" it will sometimes propose thirty seconds, and a turn that stalls
 * that long with no output looks broken from the outside.
 */
const SETTLE_DEFAULT_MS = 600;
const SETTLE_MAX_MS = 5_000;

const TASK_TIMEOUT_DEFAULT_MS = 120_000;
const TASK_TIMEOUT_MAX_MS = 600_000;

/** Problems reported per call. Beyond this it is a build log, not an answer. */
const MAX_DIAGNOSTICS = 200;

export async function runHostCall(call: HostCall, folder: string): Promise<HostAnswer> {
  try {
    switch (call.tool) {
      case 'VSCodeDiagnostics': return await diagnostics(call.input, folder);
      case 'VSCodeTasks': return await tasks(call.input);
      case 'VSCodeWorkspace': return await workspace(call.input, folder);
      default:
        return { ok: false, error: `unknown host tool ${String((call as HostCall).tool)}` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Diagnostics ──────────────────────────────────────────────────────

const SEVERITY_NAME = ['error', 'warning', 'info', 'hint'] as const;

async function diagnostics(input: Record<string, unknown>, folder: string): Promise<HostAnswer> {
  const wanted = typeof input.severity === 'string' ? input.severity : 'warning';
  const floor = Math.max(0, SEVERITY_NAME.indexOf(wanted as typeof SEVERITY_NAME[number]));

  /*
    Wait before reading, not after.

    Diagnostics arrive asynchronously from language servers that were told
    about the change moments ago. Reading immediately returns the state from
    *before* the edit — which presents as "no problems" and is the most
    damaging wrong answer this tool could give.
  */
  const settle = Math.min(
    Math.max(typeof input.settleMs === 'number' ? input.settleMs : SETTLE_DEFAULT_MS, 0),
    SETTLE_MAX_MS,
  );
  if (settle > 0) await new Promise(resolve => setTimeout(resolve, settle));

  let entries = vscode.languages.getDiagnostics();

  if (typeof input.path === 'string' && input.path.trim()) {
    const target = resolveInside(input.path, folder);
    if (!target) return { ok: false, error: `path is outside the project: ${input.path}` };
    const one = vscode.languages.getDiagnostics(vscode.Uri.file(target));
    entries = [[vscode.Uri.file(target), one]];
  }

  const problems: Array<{
    file: string; line: number; column: number;
    severity: string; message: string; source?: string;
  }> = [];
  let dropped = 0;

  for (const [uri, list] of entries) {
    for (const d of list) {
      if (d.severity > floor) continue;
      if (problems.length >= MAX_DIAGNOSTICS) { dropped += 1; continue; }
      problems.push({
        // Relative, because that is how every other tool in this project
        // reports a path and how the model will want to Read it back.
        file: path.relative(folder, uri.fsPath) || path.basename(uri.fsPath),
        // One-based, matching what the editor shows and what `Read` reports.
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        severity: SEVERITY_NAME[d.severity] ?? 'info',
        message: d.message,
        ...(d.source ? { source: d.source } : {}),
      });
    }
  }

  problems.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  return {
    ok: true,
    result: {
      problems,
      total: problems.length + dropped,
      ...(dropped ? { note: `${dropped} more not shown` } : {}),
      /*
        Said explicitly, because the empty case is ambiguous and the ambiguity
        is dangerous. No problems can mean the code is clean, or that no
        language server has this file — and a model told "0 problems" will
        treat the second as the first.
      */
      ...(problems.length === 0
        ? { note: 'No problems at or above this severity. If you expected some, the '
            + 'language server for this file may not be running — a build is the check that '
            + 'does not depend on the editor.' }
        : {}),
    },
  };
}

// ── Tasks ────────────────────────────────────────────────────────────

async function tasks(input: Record<string, unknown>): Promise<HostAnswer> {
  const available = await vscode.tasks.fetchTasks();

  if (input.action === 'list') {
    return {
      ok: true,
      result: {
        tasks: available.map(t => ({
          name: t.name,
          source: t.source,
          group: typeof t.group?.id === 'string' ? t.group.id : undefined,
          /*
            Flagged rather than filtered out. A watch task is genuinely useful
            to know about and genuinely must not be run through this tool —
            it never finishes, so the call would block until the timeout and
            then report a failure for something working correctly.
          */
          background: t.isBackground || undefined,
          detail: t.detail,
        })),
      },
    };
  }

  const name = String(input.name ?? '');
  const found = available.find(t => t.name === name)
    ?? available.find(t => t.name.toLowerCase() === name.toLowerCase());
  if (!found) {
    return {
      ok: false,
      error: `no task named ${JSON.stringify(name)}. Available: `
        + (available.map(t => t.name).join(', ') || '(none configured)'),
    };
  }
  if (found.isBackground) {
    return {
      ok: false,
      error: `${found.name} is a background task — it never finishes, so it cannot be `
        + 'waited on. Start it from the Run Task menu, or run its command directly.',
    };
  }

  const timeout = Math.min(
    Math.max(typeof input.timeoutMs === 'number' ? input.timeoutMs : TASK_TIMEOUT_DEFAULT_MS, 1_000),
    TASK_TIMEOUT_MAX_MS,
  );

  const execution = await vscode.tasks.executeTask(found);

  /*
    Listen before the race, dispose after it.

    `onDidEndTaskProcess` carries the exit code and `onDidEndTask` does not, so
    both are watched: a task with no process — a composite, or one whose
    provider never spawns anything — ends only through the second, and waiting
    on the first alone would time out on a task that finished immediately.
  */
  const outcome = await new Promise<{ exitCode?: number; ended: boolean }>((resolve) => {
    const subs: vscode.Disposable[] = [];
    const finish = (value: { exitCode?: number; ended: boolean }): void => {
      for (const s of subs) s.dispose();
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ended: false }), timeout);

    subs.push(vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution === execution) finish({ exitCode: e.exitCode, ended: true });
    }));
    subs.push(vscode.tasks.onDidEndTask((e) => {
      if (e.execution === execution) finish({ ended: true });
    }));
  });

  if (!outcome.ended) {
    // Left running rather than killed. The user can see it in their terminal,
    // and terminating somebody's build because a tool call grew impatient is a
    // worse outcome than an honest timeout.
    return {
      ok: false,
      error: `${found.name} did not finish within ${Math.round(timeout / 1000)}s. `
        + 'It is still running in the terminal.',
    };
  }

  return {
    ok: true,
    result: {
      task: found.name,
      exitCode: outcome.exitCode ?? null,
      succeeded: outcome.exitCode === undefined ? null : outcome.exitCode === 0,
      /*
        The output is not here, and cannot be.

        Reading a task's terminal needs `taskExecutionTerminal`, a proposed API
        Microsoft allowlists per publisher — Copilot Chat has it and we cannot.
        Saying so is better than an empty `output` field, which reads as "the
        task printed nothing".
      */
      note: 'Output is in the terminal, which an extension cannot read without a proposed '
        + 'API. Use the exit code, or run the command through Bash when you need its output.',
    },
  };
}

// ── Workspace ────────────────────────────────────────────────────────

async function workspace(input: Record<string, unknown>, folder: string): Promise<HostAnswer> {
  const folders = vscode.workspace.workspaceFolders ?? [];

  if (input.action === 'info') {
    return {
      ok: true,
      result: {
        folders: folders.map(f => ({ name: f.name, path: f.uri.fsPath })),
        file: vscode.workspace.workspaceFile?.fsPath ?? null,
        // Which one aico is actually working in, which is not always the first.
        active: folder,
      },
    };
  }

  const raw = String(input.path ?? '');

  if (input.action === 'createFolder') {
    const target = resolveMaybeOutside(raw, folder);
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(target));
    return { ok: true, result: { created: target } };
  }

  if (input.action === 'addFolder') {
    const target = resolveMaybeOutside(raw, folder);
    /*
      Confirmed, because it rewrites the user's workspace.

      Adding a root turns a single-folder window into a multi-root one, which
      changes what every search and every task sees — and, if the window was
      not already a workspace, prompts to save a `.code-workspace` file.
    */
    const choice = await vscode.window.showInformationMessage(
      `Add ${target} to this workspace?`, { modal: true }, 'Add',
    );
    if (choice !== 'Add') return { ok: false, error: 'the user declined to add the folder' };

    const added = vscode.workspace.updateWorkspaceFolders(
      folders.length, 0, { uri: vscode.Uri.file(target) },
    );
    return added
      ? { ok: true, result: { added: target } }
      : { ok: false, error: 'VS Code refused to add the folder — it may already be in the workspace' };
  }

  if (input.action === 'openFolder') {
    const target = resolveMaybeOutside(raw, folder);
    /*
      The one operation that ends the window.

      Opening a folder replaces the workbench: extensions reload, unsaved
      editors prompt, and this panel is rebuilt from scratch. The conversation
      survives — it lives in the server's log, not in the webview — but nothing
      about that is obvious from the inside, so the prompt says it.
    */
    const choice = await vscode.window.showWarningMessage(
      `Open ${target}? This window will reload — aico keeps the conversation, `
      + 'but unsaved changes are yours to save first.',
      { modal: true }, 'Open',
    );
    if (choice !== 'Open') return { ok: false, error: 'the user declined to open the folder' };

    /*
      Answered before the window goes.

      `openFolder` does not return — the extension host is torn down mid-call —
      so a result reported afterwards is never sent, and the tool call would be
      resolved by the turn-end sweep as a failure. Reporting success first and
      then acting is the only ordering that tells the truth.
    */
    setTimeout(() => {
      void vscode.commands.executeCommand(
        'vscode.openFolder', vscode.Uri.file(target), { forceReuseWindow: true },
      );
    }, 250);
    return { ok: true, result: { opening: target, note: 'The window is reloading.' } };
  }

  return { ok: false, error: `unknown action ${JSON.stringify(input.action)}` };
}

// ── Paths ────────────────────────────────────────────────────────────

/**
 * A path that must stay inside the project.
 *
 * Returns undefined rather than throwing, so the caller decides what the
 * refusal says. `path.relative` is the check rather than a string prefix
 * comparison: `/project-evil` starts with `/project` and is not inside it.
 */
function resolveInside(raw: string, folder: string): string | undefined {
  const resolved = path.resolve(folder, raw);
  const rel = path.relative(folder, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return resolved;
}

/**
 * A path that is allowed to point somewhere new.
 *
 * Only for the operations whose purpose is to leave the current project —
 * creating a sibling directory for a new app, opening it afterwards. Each of
 * those confirms with the user, which is what makes the wider range acceptable:
 * the check that matters is a human reading the destination, not a prefix test.
 */
function resolveMaybeOutside(raw: string, folder: string): string {
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(folder, raw);
}
