/**
 * Two deny-only guards for the agent's own changes (ADR 0033).
 *
 *  - `change-safety-commit`: a `git commit` typed into any shell tool is refused
 *    when the change it would commit adds a secret. The `Git` tool and
 *    `AppManage commit` check the same thing in their own bodies; a model that
 *    reaches for `git commit` in Bash must not get around them. Applies at
 *    every autonomy level — there is nothing for a person to approve about a
 *    key in history, only to rotate it.
 *  - `test-tamper`: where no person is watching (L4, cron, background,
 *    headless), deleting a test file or adding a skip marker to one needs a
 *    person. Attended, the turn-end gate (`security/change-safety.ts`) names
 *    the weakened test and asks the model to restore it or justify it; a person
 *    is there to read that, and the permission card already shows the edit.
 *    Either way a deleted test is noted so that gate can name it.
 *
 * Guards can only deny or abstain (ADR 0002), and are scoped to their run's
 * agent. Each denial is handed to the finding sink (`safety/finding`).
 *
 * Deliberately not here: refusing every test edit while a check fails (the
 * legitimate fix is sometimes in the test), or reading code to decide whether
 * an edit "weakens" it — only the unambiguous cases need a person.
 *
 * @module tools/change-safety-guard
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ToolPipeline, ToolCallContext } from './pipeline.js';
import { shellCommandOf } from '../safety.js';
import { pushNotification } from '../background/notifications.js';
import { splitCommands, tokenize } from './package-parse.js';
import { emit, type FindingSink } from '../security/finding.js';
import { describeDiffSecrets, noteTamperObserved, recordRefusedCommit, secretsInDiff } from '../security/change-safety.js';
import { deletedTestPaths, isTestFile, skipMarkerIncrease, testLangOf } from '../security/test-tamper.js';

export interface ChangeSafetyGuardOptions {
  agentId: string;
  cwd: () => string;
  /** `completionGate.changeSafety !== false`; read live. */
  enabled: () => boolean;
  /** No person attends this run (L4, cron, background, headless). */
  unattended: boolean;
  record?: FindingSink | undefined;
  sessionId?: string | undefined;
}

/**
 * Whether a shell command commits, and what it would commit: the index (`staged`),
 * every tracked change (`tracked`, `git commit -a`), or everything including new
 * files (`worktree`) when it stages in the same line.
 */
export function commitScope(command: string): 'staged' | 'tracked' | 'worktree' | undefined {
  let sawAdd = false;
  let scope: 'staged' | 'tracked' | 'worktree' | undefined;
  for (const seg of splitCommands(command)) {
    const w = tokenize(seg);
    while (w.length && /^(?:sudo|call|time|command|env)$/i.test(w[0]!)) w.shift();
    if (!w.length || path.basename(w[0]!).toLowerCase().replace(/\.exe$/, '') !== 'git') continue;
    let i = 1;
    // Global options: `-C dir`, `-c key=value`, `--no-pager`, `--git-dir=…`.
    while (i < w.length && w[i]!.startsWith('-')) i += /^-[Cc]$|^--(?:git-dir|work-tree|namespace|exec-path)$/.test(w[i]!) ? 2 : 1;
    const sub = w[i]?.toLowerCase();
    const rest = w.slice(i + 1);
    if (sub === 'add' || sub === 'stage') sawAdd = true;
    if (sub === 'commit') {
      const all = rest.some(a => a === '--all' || /^-[A-Za-z]*a[A-Za-z]*$/.test(a));
      scope = sawAdd ? 'worktree' : all ? 'tracked' : (scope ?? 'staged');
    }
  }
  return scope;
}

const lf = (t: string): string => t.replace(/\r\n/g, '\n');

export function installChangeSafetyGuards(pipeline: ToolPipeline, o: ChangeSafetyGuardOptions): () => void {
  const offCommit = pipeline.onGuard('change-safety-commit', async (ctx: ToolCallContext) => {
    if (ctx.agentId !== o.agentId || !o.enabled()) return { kind: 'abstain' };
    const command = shellCommandOf(ctx.name, ctx.arguments);
    if (command === undefined || !/\bgit\b/i.test(command)) return { kind: 'abstain' };
    const scope = commitScope(command);
    if (!scope) return { kind: 'abstain' };
    const cwd = typeof ctx.arguments?.cwd === 'string' && ctx.arguments.cwd ? ctx.arguments.cwd : o.cwd();
    let found;
    try { found = await secretsInDiff(cwd, scope); } catch { return { kind: 'abstain' }; } // no usable git: do not invent a failure
    if (!found.length) return { kind: 'abstain' };
    recordRefusedCommit(found, o.record);
    return { kind: 'deny', reason: `BLOCKED (change safety): this commit did not run — ${describeDiffSecrets(found)}` };
  });

  const offTamper = pipeline.onGuard('test-tamper', async (ctx: ToolCallContext) => {
    if (ctx.agentId !== o.agentId || !o.enabled()) return { kind: 'abstain' };
    const args = ctx.arguments ?? {};
    const refuse = (kind: 'test-file-deleted' | 'skip-marker-added', subject: string, what: string) => {
      emit(o.record, { control: 'test-tamper', rule: kind, severity: 'high', outcome: 'denied', file: subject, subject, detail: what });
      pushNotification({
        title: 'Stopped a change that weakens a test',
        body: `${what}. Nobody was there to approve it, so it did not run.`,
        level: 'warning',
        sourceId: `test-tamper:${o.sessionId ?? o.agentId}`,
      });
      return {
        kind: 'deny' as const,
        reason: `BLOCKED (test-tamper guard): ${what}. Deleting or skipping a test needs a person, and nobody is available to approve it in this run, so it did not run. `
          + 'A check is only evidence if the test is allowed to fail: fix the code instead. If the test itself is wrong, finish everything else and say in your final report that this step needs a person.',
      };
    };

    const command = shellCommandOf(ctx.name, args);
    if (command !== undefined) {
      if (!/\b(?:rm|del|erase|rd|rmdir|remove-item|ri|unlink|trash|git)\b/i.test(command)) return { kind: 'abstain' };
      const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : o.cwd();
      const gone = deletedTestPaths(command, cwd);
      if (!gone.length) return { kind: 'abstain' };
      for (const f of gone) noteTamperObserved({ kind: 'test-file-deleted', file: f, detail: `${f} was deleted by a shell command` });
      if (!o.unattended) return { kind: 'abstain' };
      return refuse('test-file-deleted', gone[0]!, `this command deletes test file(s): ${gone.slice(0, 3).join(', ')}`);
    }

    if (!o.unattended || (ctx.name !== 'Edit' && ctx.name !== 'Write')) return { kind: 'abstain' };
    const target = typeof args.file_path === 'string' ? path.resolve(o.cwd(), args.file_path) : '';
    const rel = target ? path.relative(o.cwd(), target).replace(/\\/g, '/') : '';
    const lang = rel ? testLangOf(rel) : undefined;
    if (!lang || !isTestFile(rel)) return { kind: 'abstain' };
    let current: string | null = null;
    try { current = fs.readFileSync(target, 'utf8'); } catch { current = null; }
    let after: string | undefined;
    if (ctx.name === 'Write') after = typeof args.content === 'string' ? args.content : undefined;
    else if (current !== null && typeof args.old_str === 'string' && typeof args.new_str === 'string') {
      const cur = lf(current); const old = lf(args.old_str);
      const at = cur.indexOf(old);
      if (at >= 0) after = cur.slice(0, at) + lf(args.new_str) + cur.slice(at + old.length);
    }
    if (after === undefined) return { kind: 'abstain' };
    if (skipMarkerIncrease(current === null ? null : lf(current), lf(after), lang) > 0) {
      return refuse('skip-marker-added', rel, `this ${ctx.name} adds a skip/focus marker to ${rel}`);
    }
    return { kind: 'abstain' };
  });

  return () => { offCommit(); offTamper(); };
}
