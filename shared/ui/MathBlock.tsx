/**
 * A formula set as a formula.
 *
 * ## Why this exists when `$$…$$` already worked
 *
 * It did work, and nothing said so. The prompt's list of what a fenced block
 * can become never mentioned mathematics, so a model asked to teach algebra
 * wrote `2x = 10` in backticks and drew a balance scale out of ASCII art — a
 * reasonable thing to do if you believe plain text is all you have. KaTeX was
 * loaded and parsing on that very page.
 *
 * The same failure as the diagrams and the dashboard: a capability nobody is
 * told about is one that gets routed around. Putting maths in the catalogue is
 * the fix; this renderer is what the catalogue entry points at.
 *
 * ## And why a block, not only inline maths
 *
 * `$$…$$` sets a formula in the flow of prose, which is right for one line and
 * wrong for a derivation. A fenced block gets the widget frame — so a long
 * proof can be copied, downloaded, expanded to fill the window, or collapsed
 * out of the way — and gets the repair path when the TeX does not parse.
 *
 * @module shared/ui/MathBlock
 */

import React, { useEffect, useState } from 'react';

/**
 * KaTeX, plus mhchem for chemistry.
 *
 * Loaded together and on demand. mhchem extends KaTeX in place rather than
 * exporting anything, so the import is a side effect and the order matters —
 * it has to find KaTeX already there to attach `\ce` and `\pu` to.
 */
type Katex = { renderToString: (tex: string, options?: Record<string, unknown>) => string };

let katexPromise: Promise<Katex> | null = null;

function loadKatex(): Promise<Katex> {
  katexPromise ??= import('katex').then(async (module) => {
    await import('katex/dist/contrib/mhchem.mjs');
    // Interop: the ESM build puts it on `default`, the bundled one on the
    // namespace. Taking whichever is there costs a line and avoids a runtime
    // failure that only shows up in one of the two builds.
    return ((module as { default?: Katex }).default ?? module) as Katex;
  });
  return katexPromise;
}

export interface MathBlockProps {
  source: string;
  /** Suppressed while the block is still arriving, so half a formula is not set. */
  streaming?: boolean;
}

export function MathBlock({ source, streaming = false }: MathBlockProps): React.ReactElement {
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (streaming) return;
    let cancelled = false;
    void loadKatex().then((katex) => {
      if (cancelled) return;
      try {
        setHtml(katex.renderToString(source.trim(), {
          displayMode: true,
          // Errors are ours to report through the frame, which offers to have
          // them fixed. KaTeX's own inline red text would bypass that.
          throwOnError: true,
          // Not strict: a model mid-derivation writes Unicode minus signs and
          // stray `\text` spacing that are technically warnings, and failing a
          // correct formula over a pedantry is worse than setting it.
          strict: false,
          trust: false,
          macros: {
            // The handful anyone teaching or deriving reaches for and KaTeX
            // does not define. Cheaper than the model discovering they are
            // missing one failed render at a time.
            '\\deriv': '\\frac{d#1}{d#2}',
            '\\pderiv': '\\frac{\\partial#1}{\\partial#2}',
            '\\abs': '\\left|#1\\right|',
            '\\norm': '\\left\\|#1\\right\\|',
          },
        }));
        setError('');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });
    return () => { cancelled = true; };
  }, [source, streaming]);

  if (streaming) {
    return <p className="p-2 text-[11px] text-aico-muted">Formula arriving…</p>;
  }
  if (error) {
    // Thrown so the frame owns the failure and offers the repair, exactly as it
    // does for a chart or a diagram.
    throw new Error(error.split(String.fromCharCode(10))[0]);
  }
  if (!html) {
    return <p className="p-2 text-[11px] text-aico-muted">Setting…</p>;
  }

  return (
    <div
      // KaTeX's own markup, produced with `trust: false`, which refuses every
      // command that can emit a URL or raw HTML.
      dangerouslySetInnerHTML={{ __html: html }}
      className="overflow-x-auto px-2 py-3 text-aico-primary [&_.katex-display]:my-0"
    />
  );
}
