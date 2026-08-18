/**
 * What has been verified, and whether it still counts.
 *
 * A verification tool the agent may call is a suggestion. What makes it a
 * requirement is that something reads the verdict at the end of the turn and
 * refuses to call the work finished when it failed — which is what this module
 * exists for.
 *
 * Two rules, and both matter:
 *
 * **A verdict has to be about the current artifact.** Verify, find a bug, fix
 * it, stop — and the last verdict on record is the passing one from before the
 * fix, or the failing one that the fix already addressed. Neither describes
 * what is on disk now. So a verdict is stale the moment its file changes, and
 * a stale verdict is not evidence.
 *
 * **Only work that could be verified is gated.** A turn that answered a
 * question, edited a config or wrote a script has nothing to open in a browser,
 * and demanding a verdict from it would be a tax on every unrelated task. The
 * gate looks for a web artifact and stays quiet when there is not one.
 *
 * Per-turn state, reset at the start of each turn, because "verified" is a
 * claim about this piece of work and not a property the session accumulates.
 *
 * @module verification
 */

import fs from 'fs';
import path from 'path';
import { currentCwd } from './run-context.js';

/** The subset of a browser verdict the gate needs. */
export interface VerificationRecord {
  url: string;
  passed: boolean;
  problems: string[];
  /** Absolute path of the file that was checked, when it was a file. */
  file?: string;
  /** Modification time of that file at check time — how staleness is detected. */
  fileMtimeMs?: number;
  at: number;
}

/** Something built during this turn that a browser could open. */
export interface WebArtifact {
  file: string;
  mtimeMs: number;
}

let records: VerificationRecord[] = [];
let artifacts = new Map<string, number>();

/** Start of turn: last turn's evidence says nothing about this one. */
export function resetVerification(): void {
  records = [];
  artifacts = new Map();
}

/** Extensions a browser can open and this loop can therefore be held to. */
const WEB_EXTENSIONS = new Set(['.html', '.htm']);

/**
 * Note that a file was written or edited.
 *
 * Called from the write path rather than inferred at the end, because by then
 * the only thing left is a directory listing and no way to tell what this turn
 * produced from what was already there.
 */
export function noteFileWritten(file: string): void {
  if (!WEB_EXTENSIONS.has(path.extname(file).toLowerCase())) return;
  const abs = path.isAbsolute(file) ? file : path.join(currentCwd(), file);
  try {
    artifacts.set(abs, fs.statSync(abs).mtimeMs);
  } catch {
    // Written but already gone, or unreadable. Nothing to gate on.
  }
}

/** Record a browser verdict, with the artifact's mtime so staleness is detectable. */
export function recordVerification(verdict: {
  url: string; passed: boolean; problems: string[];
}): void {
  const record: VerificationRecord = {
    url: verdict.url,
    passed: verdict.passed,
    problems: verdict.problems,
    at: Date.now(),
  };

  if (verdict.url.startsWith('file:')) {
    try {
      const file = decodeURIComponent(new URL(verdict.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
      record.file = file;
      record.fileMtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      // No mtime means it cannot be shown to be fresh, and unprovable freshness
      // is treated as stale below. That is the safe direction to fail.
    }
  }

  records.push(record);
}

/** Everything recorded this turn, oldest first. */
export function verifications(): readonly VerificationRecord[] {
  return records;
}

export interface GateResult {
  /** Whether the turn may end as completed. */
  ok: boolean;
  /** What to tell the model, in the terms it needs to act on. */
  message?: string;
}

/**
 * May this turn call itself finished?
 *
 * Three ways to fail, and each gets a different message because each needs a
 * different next action: never verified, verified and failing, or verified
 * before the last change.
 */
export function checkVerificationGate(): GateResult {
  if (artifacts.size === 0) return { ok: true };

  // Freshest mtime wins — a turn that touched several pages is judged on the
  // one most recently changed, which is the one least likely to have a current
  // verdict.
  const current = [...artifacts.entries()].map(([file, mtimeMs]) => {
    try { return { file, mtimeMs: fs.statSync(file).mtimeMs }; } catch { return { file, mtimeMs }; }
  });

  const unverified = current.filter(a =>
    !records.some(r => r.file && path.resolve(r.file) === path.resolve(a.file)));

  if (unverified.length === current.length) {
    const list = unverified.map(a => path.basename(a.file)).join(', ');
    return {
      ok: false,
      message:
        `You built ${list} but never opened it. Reading the source you just wrote is not `
        + `verification — a page can look right in source and throw on load, render blank, or `
        + `have controls that do nothing. Call VerifyApp on it, with checks covering the `
        + `interactions the user asked for, and fix whatever it reports before finishing.`,
    };
  }

  for (const artifact of current) {
    const forFile = records.filter(r => r.file && path.resolve(r.file) === path.resolve(artifact.file));
    const latest = forFile[forFile.length - 1];
    if (!latest) continue;

    // Strictly older, not older-or-equal: a verdict taken in the same
    // millisecond as the write is the one that observed it, and coarse
    // filesystem timestamps would otherwise reject every honest verification.
    if (latest.fileMtimeMs === undefined || latest.fileMtimeMs < artifact.mtimeMs) {
      return {
        ok: false,
        message:
          `${path.basename(artifact.file)} changed after it was last verified, so the last `
          + `result no longer describes what is on disk. Run VerifyApp again — a fix is not `
          + `finished until the check that found the problem passes.`,
      };
    }

    if (!latest.passed) {
      const problems = latest.problems.slice(0, 5).map(p => `  - ${p}`).join('\n');
      return {
        ok: false,
        message:
          `${path.basename(artifact.file)} does not work. The browser reported:\n${problems}\n`
          + `Fix these and verify again. Do not summarise this as done — a page that throws on `
          + `load is not a finished artifact, whatever its source looks like.`,
      };
    }
  }

  return { ok: true };
}

/** Artifacts seen this turn. Exposed for tests and for the turn summary. */
export function webArtifacts(): WebArtifact[] {
  return [...artifacts.entries()].map(([file, mtimeMs]) => ({ file, mtimeMs }));
}
