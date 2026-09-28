/**
 * A unified diff drawn with line numbers on both sides and hunk headers.
 * @module desktop/renderer/ide/DiffView
 */

import React, { useMemo } from 'react';
import { cls } from '@/lib/util';

interface Line { kind: 'add' | 'del' | 'ctx' | 'hunk' | 'meta'; text: string; a?: number; b?: number }

export function parseDiff(diff: string): Line[] {
  const out: Line[] = [];
  let a = 0; let b = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('new file') || raw.startsWith('deleted file') || raw.startsWith('similarity') || raw.startsWith('rename ')) {
      out.push({ kind: 'meta', text: raw });
      continue;
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (h) { a = Number(h[1]); b = Number(h[2]); out.push({ kind: 'hunk', text: raw }); continue; }
    if (raw.startsWith('+')) { out.push({ kind: 'add', text: raw.slice(1), b: b++ }); continue; }
    if (raw.startsWith('-')) { out.push({ kind: 'del', text: raw.slice(1), a: a++ }); continue; }
    if (raw.startsWith('\\')) { out.push({ kind: 'meta', text: raw }); continue; }
    out.push({ kind: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : raw, a: a++, b: b++ });
  }
  return out;
}

export function DiffView({ diff }: { diff: string }): React.ReactElement {
  const lines = useMemo(() => parseDiff(diff), [diff]);
  return (
    <table className="w-full border-collapse font-mono text-[12.5px] leading-[20px] selectable">
      <tbody>
        {lines.filter(l => l.kind !== 'meta').map((l, i) => (
          <tr key={i} className={cls(l.kind === 'add' && 'diff-add', l.kind === 'del' && 'diff-remove', l.kind === 'hunk' && 'bg-aico-accent-soft text-aico-accent')}>
            <td className="w-12 select-none border-r border-aico-border-subtle pr-2 text-right text-[11px] text-aico-muted">{l.a ?? ''}</td>
            <td className="w-12 select-none border-r border-aico-border-subtle pr-2 text-right text-[11px] text-aico-muted">{l.b ?? ''}</td>
            <td className="w-5 select-none text-center text-aico-muted">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</td>
            <td className="whitespace-pre-wrap break-all pr-4">{l.kind === 'hunk' ? l.text : l.text || ' '}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
