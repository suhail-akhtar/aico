/**
 * Whether the project currently builds, derived from the transcript.
 *
 * Same shape as the task list and the plan: `RunChecks` reports its verdict
 * into the log, so the current state is the last one that went past. No
 * endpoint, no polling, and no second source that can disagree with the
 * conversation — and it replays, so reopening a session shows the state its
 * last run left behind rather than a blank panel.
 *
 * Parsed from the report rather than a structured payload because the report is
 * what the log stores. The format is fixed and written a few lines away, in
 * `src/tools/run-checks.ts`, and the parse fails closed: a line it cannot read
 * is a check it does not claim to know about.
 *
 * @module checks
 */

import type { ChatMessage } from '@aico/ui';

export interface CheckLine {
  name: string;
  command: string;
  passed: boolean;
  seconds: number;
}

export interface ChecksState {
  lines: CheckLine[];
  passed: number;
  failed: number;
  /** True when every check the project defines came back green. */
  allGreen: boolean;
  /** The failing check's output, when there is one. */
  failureOutput?: string;
  /** Checks that never ran because an earlier one failed. */
  notRun: string[];
  /** Identity of this run, for dismissal. */
  signature: string;
}

/** `PASS  typecheck  npm run typecheck  (0.3s)` */
const LINE = /^(PASS|FAIL)\s+(\S+)\s+(.*?)\s+\(([\d.]+)s\)\s*$/;

const EMPTY: ChecksState = {
  lines: [], passed: 0, failed: 0, allGreen: false, notRun: [], signature: '',
};

/**
 * The state of the project's checks, from the last RunChecks in the transcript.
 *
 * Read backwards and stop at the first: each run reports the whole suite, so
 * the newest is the entire answer and merging older ones would resurrect
 * results the code has moved past.
 */
export function checksFrom(messages: ChatMessage[]): ChecksState {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.type !== 'tool' || message.toolName !== 'RunChecks') continue;
    const report = typeof message.toolResult === 'string' ? message.toolResult : '';
    if (!report) continue;

    const lines: CheckLine[] = [];
    for (const raw of report.split('\n')) {
      const hit = LINE.exec(raw.trim());
      if (!hit) continue;
      lines.push({
        passed: hit[1] === 'PASS',
        name: hit[2]!,
        command: hit[3]!,
        seconds: Number(hit[4]),
      });
    }
    if (lines.length === 0) continue;

    const failed = lines.filter(l => !l.passed).length;
    const notRunLine = /^Not run: ([^—]+)—/m.exec(report);
    // Everything after the "Output from x:" heading, up to the closing advice.
    const output = /^Output from .+?:\n([\s\S]*?)(?:\n\nNot run:|\n\nFix this|$)/m.exec(report);

    return {
      lines,
      passed: lines.length - failed,
      failed,
      allGreen: failed === 0,
      ...(output?.[1]?.trim() ? { failureOutput: output[1].trim() } : {}),
      notRun: notRunLine?.[1]?.split(',').map(s => s.trim()).filter(Boolean) ?? [],
      signature: lines.map(l => `${l.name}:${l.passed}`).join('|'),
    };
  }

  return EMPTY;
}
