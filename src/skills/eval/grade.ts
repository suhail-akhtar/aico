/**
 * Turning a run into a number.
 *
 * Kept separate from running so it can be tested without a model: a grader that
 * can only be exercised by spending money is a grader nobody checks.
 *
 * @module skills/eval/grade
 */

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Check, CheckResult } from './types.js';

/** What a check needs to see. Everything is captured before grading starts. */
export interface Evidence {
  output: string;
  toolCalls: string[];
  /** Scratch directory the task ran in. */
  cwd: string;
  /** Content hashes of the fixture as written, by relative path. */
  fixtureHashes: Record<string, string>;
}

export function hashFiles(cwd: string, files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of Object.keys(files)) out[rel] = sha(files[rel] ?? '');
  return out;
}

function sha(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

function re(pattern: string, flags?: string): RegExp {
  // Multiline by default: most checks are "a line that says X", and a reply is
  // many lines. Callers pass their own flags when they mean something else.
  return new RegExp(pattern, flags ?? 'im');
}

export function runCheck(check: Check, evidence: Evidence): boolean {
  switch (check.kind) {
    case 'output-matches':
      return re(check.pattern, check.flags).test(evidence.output);
    case 'output-lacks':
      return !re(check.pattern, check.flags).test(evidence.output);
    case 'file-exists':
      return fs.existsSync(path.join(evidence.cwd, check.path));
    case 'file-matches': {
      const file = path.join(evidence.cwd, check.path);
      if (!fs.existsSync(file)) return false;
      return re(check.pattern, check.flags).test(fs.readFileSync(file, 'utf8'));
    }
    case 'no-file-changed':
      return Object.entries(evidence.fixtureHashes).every(([rel, hash]) => {
        const file = path.join(evidence.cwd, rel);
        return fs.existsSync(file) && sha(fs.readFileSync(file, 'utf8')) === hash;
      });
    case 'max-tool-calls':
      return evidence.toolCalls.length <= check.limit;
  }
}

/**
 * Weighted fraction passed.
 *
 * A fraction rather than pass/fail because the optimiser needs a gradient. A
 * skill that names three of four planted bugs is better than one that names
 * two, and a binary score cannot say so — it would call both "failed" and give
 * the optimiser nothing to move toward.
 */
export function grade(checks: Check[], evidence: Evidence): { score: number; results: CheckResult[] } {
  const results = checks.map(check => ({ check, passed: runCheck(check, evidence) }));
  const total = checks.reduce((n, c) => n + (c.weight ?? 1), 0);
  const earned = results.reduce((n, r) => n + (r.passed ? (r.check.weight ?? 1) : 0), 0);
  return { score: total === 0 ? 1 : earned / total, results };
}
