/**
 * Shell confinement, the stage: a shell command that writes outside the
 * project, downloads a program, installs globally, runs what it downloaded or
 * changes the system needs a person (ADR 0027).
 *
 * WHY A PERSON AND NOT THE SENTINEL. The Phase 0 benchmark's auto-approve turn
 * fetched a Go toolchain and wrote shims into `~/bin`. The Sentinel would have
 * reviewed some of that, but in full autonomy an escalation proceeds unasked,
 * and a reviewer's judgement is the wrong tool for a fact the command text
 * states outright: *this writes to C:\Users\me\bin*. So, like buying and
 * sending in the browser (ADR 0005), these are person-required at every
 * autonomy level, full autonomy included; the person's standing answers are
 * `shell.allowedWriteRoots` and `shell.allowDownloads` (user settings only;
 * widening them needs a person — `safetyWeakening`).
 *
 * HOW IT ASKS. Under ask/edits the generic permission card already asks about
 * every shell call; it shows "writes outside the project: <path>" (via
 * {@link ShellConfinement.note}) and marks the call `SHOWN`, so the person is
 * asked once. Under auto/full this guard asks through the run's approval card
 * (`ask`), and a yes sets `HUMAN_APPROVED` so the Sentinel does not ask again
 * about the call the person just saw. Unattended (L4, cron, background) or
 * with nobody to ask: refused with the fix named, and a notification — the
 * approve-later inbox replays only custom tools, so a shell call is not parked.
 *
 * A guard: it can only deny or abstain (ADR 0002). Scoped to its run's agent.
 *
 * @module tools/shell-confinement-guard
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolPipeline, ToolCallContext } from './pipeline.js';
import { shellCommandOf } from '../safety.js';
import { aicoHome } from '../home.js';
import { writableRoots } from './path.js';
import { terminalCwd } from './terminal.js';
import { pushNotification } from '../background/notifications.js';
import {
  assessShellCommand, describeFindings, newDownloadTracker,
  type ConfinementFinding, type DownloadTracker,
} from './shell-confinement.js';

/** `ctx.state` key: the permission card showed this call's confinement note and the person said yes. */
export const SHELL_CONFINEMENT_SHOWN = 'shell-confinement-shown';

export interface ShellConfinementOptions {
  agentId: string;
  /** The run's working directory (the project). */
  cwd: () => string;
  settings?: { shell?: { allowedWriteRoots?: string[]; allowDownloads?: boolean } } | undefined;
  /** Ask a person; undefined when nobody can be asked. */
  ask?: ((title: string, detail: string) => Promise<boolean>) | undefined;
  /** No person attends this run (L4, cron, background, headless). */
  unattended: boolean;
  /** `ctx.state` key a person's approval sets (the Sentinel's `HUMAN_APPROVED`). */
  approvedKey: string;
  sessionId?: string | undefined;
}

export interface ShellConfinement {
  /** Findings for a call; empty for anything that is not a shell command or stays inside. */
  assess(name: string, args: Record<string, unknown>): ConfinementFinding[];
  /** The permission card's note, e.g. `writes outside the project: C:\Users\me\bin`; undefined when none. */
  note(name: string, args: Record<string, unknown>): string | undefined;
  /** Register the `shell-confinement` guard. Returns the disposer. */
  install(pipeline: ToolPipeline): () => void;
}

/** Where `p` really is: the nearest existing ancestor's real path, plus the rest (as `tools/path` does). */
function realLocation(p: string): string {
  let head = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(head), ...rest);
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return path.resolve(p);
      rest.unshift(path.basename(head));
      head = parent;
    }
  }
}

const expandHome = (p: string): string => (p === '~' || /^~[\\/]/.test(p) ? os.homedir() + p.slice(1) : p);

export function createShellConfinement(o: ShellConfinementOptions): ShellConfinement {
  const tracker: DownloadTracker = newDownloadTracker();

  const shellCwd = (name: string, args: Record<string, unknown>): string => {
    if (typeof args.cwd === 'string' && args.cwd) return args.cwd;
    if (name === 'Terminal') return terminalCwd() ?? o.cwd();
    return o.cwd();
  };

  const assess = (name: string, args: Record<string, unknown>): ConfinementFinding[] => {
    const command = shellCommandOf(name, args);
    if (command === undefined) return [];
    const project = o.cwd();
    const shell = o.settings?.shell;
    const extra = (Array.isArray(shell?.allowedWriteRoots) ? shell!.allowedWriteRoots : [])
      .filter((r): r is string => typeof r === 'string' && r.trim() !== '')
      .map(r => path.resolve(expandHome(r.trim())));
    const tmp = os.tmpdir();
    const store = aicoHome();
    let own: string[];
    try { own = writableRoots(project); } catch { own = [path.resolve(project)]; }
    // The AICO workspace (session scratch lives there) — writable, and where a download lands.
    const workspaces = own.filter(r => r !== path.resolve(project) && r !== path.join(store, 'skills'));
    return assessShellCommand(command, {
      cwd: shellCwd(name, args),
      roots: [...own, tmp, path.join(store, 'tmp'), ...extra],
      projectRoot: project,
      scratchRoots: [tmp, path.join(store, 'tmp'), path.join(store, 'workspace'), ...workspaces],
      home: os.homedir(),
      env: process.env,
      allowDownloads: shell?.allowDownloads === true,
      tracker,
      realpath: realLocation,
      tmpdir: tmp,
    });
  };

  const note = (name: string, args: Record<string, unknown>): string | undefined => {
    const findings = assess(name, args);
    return findings.length ? describeFindings(findings) : undefined;
  };

  const install = (pipeline: ToolPipeline): (() => void) => pipeline.onGuard('shell-confinement', async (ctx: ToolCallContext) => {
    if (ctx.agentId !== o.agentId) return { kind: 'abstain' };
    if (ctx.state.get(SHELL_CONFINEMENT_SHOWN) === true || ctx.state.get(o.approvedKey) === true) return { kind: 'abstain' };
    const findings = assess(ctx.name, ctx.arguments ?? {});
    if (!findings.length) return { kind: 'abstain' };
    const summary = describeFindings(findings);
    const fix = 'Keep writes inside the project or the session scratch folder (WorkspaceInfo shows it), install packages project-locally '
      + '(npm install without -g, pip into a .venv in the project), or ask the person to run it themselves. '
      + 'A person can allow a folder in Settings → Permissions → "Extra folders shell commands may write to" (shell.allowedWriteRoots) '
      + 'or downloads in "Let shell commands download and install programs" (shell.allowDownloads).';

    if (o.unattended || !o.ask) {
      pushNotification({
        title: `Stopped a ${ctx.name} command outside the project`,
        body: `It ${summary}. Nobody was there to approve it, so it did not run.`,
        level: 'warning',
        sourceId: `shell-confinement:${o.sessionId ?? o.agentId}`,
      });
      return {
        kind: 'deny',
        reason: `BLOCKED (shell confinement): this command ${summary}. That needs a person, and nobody is available to approve it in this run, so it did not run. ${fix} `
          + 'Do not work around it another way; finish everything else and say in your final report that this step needs a person.',
      };
    }

    let command = '';
    try { command = String(shellCommandOf(ctx.name, ctx.arguments) ?? ''); } catch { /* best effort: the summary still names the paths */ }
    const detail = [
      `This command ${summary}.`,
      'It needs your approval in every mode, full autonomy included.',
      command.length > 1200 ? `${command.slice(0, 1200)}…` : command,
    ].join('\n');
    let yes = false;
    try { yes = await o.ask(`Outside the project: ${ctx.name}`, detail); } catch { yes = false; }
    if (yes) { ctx.state.set(o.approvedKey, true); return { kind: 'abstain' }; }
    return {
      kind: 'deny',
      reason: `The person did not approve this ${ctx.name} command (it ${summary}). It was not run. ${fix} Do not try to do the same thing another way.`,
    };
  });

  return { assess, note, install };
}
