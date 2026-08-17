/**
 * What the turn did, and whether it is actually finished.
 *
 * A turn used to just stop. The last token arrived, the spinner went away, and
 * nothing said whether the work was *done* — whether the model finished because
 * it had finished, or because it hit an output ceiling mid-sentence, or because
 * a guard stopped it before it started. Those are different outcomes with
 * different next actions, and they all looked identical.
 *
 * So the headline is the outcome, not the statistics. "Done" and "Stopped early
 * — output limit reached" are the two things worth telling apart at a glance;
 * the counts are supporting detail underneath, and the files it produced are
 * the part people actually go looking for.
 *
 * @module components/TurnSummary
 */

import React from 'react';
import type { Deliverable } from '../api';

export interface TurnSummaryData {
  outcome: 'completed' | 'incomplete' | 'cancelled' | 'failed';
  headline: string;
  detail?: string;
  durationMs: number;
  steps: number;
  toolCalls: number;
  toolFailures: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  files: Deliverable[];
}

export function TurnSummary(
  { summary }: { summary: TurnSummaryData | null },
): React.ReactElement | null {
  if (!summary) return null;

  const tone = TONES[summary.outcome];

  return (
    <section className={`my-5 overflow-hidden rounded-xl border ${tone.border} ${tone.bg}`}>
      <header className="flex flex-wrap items-center gap-2 px-4 py-2.5">
        <span className={tone.text} aria-hidden>{tone.glyph}</span>
        <span className={`text-[14px] font-medium ${tone.text}`}>{summary.headline}</span>
        <div className="flex-1" />
        <span className="text-[12px] tabular-nums text-aico-muted">
          {formatDuration(summary.durationMs)}
          {summary.steps > 0 && ` · ${summary.steps} step${summary.steps === 1 ? '' : 's'}`}
          {summary.toolCalls > 0 && ` · ${summary.toolCalls} tool call${summary.toolCalls === 1 ? '' : 's'}`}
          {summary.outputTokens > 0 && ` · ${formatTokens(summary.outputTokens)} out`}
        </span>
      </header>

      {summary.detail && (
        <p className="px-4 pb-2.5 text-[13px] text-aico-secondary">{summary.detail}</p>
      )}

      {summary.files.length > 0 && (
        <div className="border-t border-aico-border-subtle px-4 py-2.5">
          <div className="mb-1.5 text-[11px] uppercase tracking-wider text-aico-muted">
            {summary.files.length} file{summary.files.length === 1 ? '' : 's'} produced
          </div>
          <ul className="space-y-0.5">
            {summary.files.map(file => (
              <li key={file.path} className="flex items-center gap-2">
                <span
                  className={file.action === 'created' ? 'text-aico-success' : 'text-aico-warning'}
                  aria-hidden
                >
                  {file.action === 'created' ? '+' : '~'}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-aico-primary" title={file.path}>
                  {file.path}
                </span>
                {file.touches > 1 && (
                  <span className="shrink-0 text-[11px] text-aico-muted" title={`Touched ${file.touches} times`}>
                    ×{file.touches}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/**
 * Colour carries the outcome, so it is readable before the words are.
 *
 * "Done" is deliberately the quietest of the four: it is the expected case, and
 * a green banner after every reply would train people to stop reading it —
 * which is exactly when the one that says "stopped early" gets missed too.
 */
const TONES = {
  completed: {
    glyph: '✓',
    border: 'border-aico-border-subtle',
    bg: 'bg-aico-surface',
    text: 'text-aico-primary',
  },
  incomplete: {
    glyph: '!',
    border: 'border-aico-warning/40',
    bg: 'bg-aico-warning/8',
    text: 'text-aico-warning',
  },
  cancelled: {
    glyph: '■',
    border: 'border-aico-border',
    bg: 'bg-aico-elevated',
    text: 'text-aico-secondary',
  },
  failed: {
    glyph: '✕',
    border: 'border-aico-danger/40',
    bg: 'bg-aico-danger/8',
    text: 'text-aico-danger',
  },
} as const;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}
