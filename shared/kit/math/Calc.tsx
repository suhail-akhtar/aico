/**
 * ```calc — a worked calculation that is actually computed.
 *
 * Each line is evaluated in order (mathjs, with units and physical constants);
 * variables carry forward; the working is typeset (KaTeX) with its result, so a
 * physics or engineering answer shows its formulas, its numbers and its units —
 * and the arithmetic is the computer's, not the model's.
 *
 * @module shared/kit/math/Calc
 */

import React, { useEffect, useMemo, useState } from 'react';
import { evaluateCalc, type CalcLine } from './core';

let katexPromise: Promise<typeof import('katex')> | null = null;
const loadKatex = (): Promise<typeof import('katex')> => (katexPromise ??= import('katex'));

function Tex({ tex, katex }: { tex: string; katex: typeof import('katex') | null }): React.ReactElement {
  if (!katex) return <code>{tex}</code>;
  try {
    return <span dangerouslySetInnerHTML={{ __html: katex.default.renderToString(tex, { throwOnError: false, displayMode: false, strict: 'ignore' }) }} />;
  } catch {
    return <code>{tex}</code>;
  }
}

export function Calc({ source, streaming = false }: { source: string; streaming?: boolean }): React.ReactElement {
  const [katex, setKatex] = useState<typeof import('katex') | null>(null);
  useEffect(() => { void loadKatex().then(setKatex); }, []);
  const lines = useMemo<CalcLine[] | { error: string } | null>(() => {
    if (streaming) return null;
    try { return evaluateCalc(source); } catch (err) { return { error: (err as Error).message }; }
  }, [source, streaming]);
  if (streaming) return <p className="p-2 text-[11px] text-aico-muted">Calculation arriving…</p>;
  if (!lines || 'error' in lines) throw new Error(lines && 'error' in lines ? lines.error : 'nothing to calculate');
  const failed = lines.filter(l => l.error).length;
  return (
    <div className="px-3 py-2">
      <table className="w-full border-collapse text-[14px]">
        <tbody>
          {lines.map((l, i) => l.comment && !l.tex && !l.error ? (
            <tr key={i}><td colSpan={2} className="pb-1 pt-3 text-[12px] font-semibold uppercase tracking-wide text-aico-muted first:pt-1">{l.comment}</td></tr>
          ) : (
            <tr key={i} className="border-b border-aico-border-subtle last:border-b-0">
              <td className="py-1.5 pr-4 align-middle">
                {l.tex ? <Tex tex={l.tex} katex={katex} /> : <code className="text-[13px]">{l.input}</code>}
                {l.comment && <span className="ml-2 text-[12px] text-aico-muted">— {l.comment}</span>}
              </td>
              <td className="py-1.5 text-right align-middle">
                {l.error
                  ? <span className="text-[12px] text-aico-danger" title={l.input}>{l.error}</span>
                  : l.result ? <span className="font-medium text-aico-accent"><Tex tex={l.name ? `${l.name} = ${l.resultTex}` : `= ${l.resultTex}`} katex={katex} /></span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-1 text-[11px] text-aico-muted">{failed ? `${failed} line${failed > 1 ? 's' : ''} could not be computed.` : 'Computed with units — every number above was calculated, not written.'}</div>
    </div>
  );
}
