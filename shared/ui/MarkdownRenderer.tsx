/**
 * The assistant's prose, and everything a fenced block can turn into.
 *
 * Markdown is the model's output format, so this is where output *quality* is
 * decided. Beyond GFM (tables, task lists, strikethrough, autolinks) it handles:
 *
 *   - **Maths** via KaTeX — `$x$` inline, `$$…$$` display. Physics and
 *     engineering answers are unreadable as raw TeX, and a model asked for a
 *     derivation writes TeX whether or not anything renders it.
 *   - **Diagrams and charts** from ```mermaid — flowcharts, sequence, ER,
 *     Gantt, pie, xy. Loaded on demand; a session without one pays nothing.
 *   - **HTML preview** from ```html, in a locked-down sandboxed frame with a
 *     source toggle. See `HtmlPreview` for why the defaults are what they are.
 *   - **Code** with a copy button and a language label.
 *   - **Tables** that scroll inside their own box, so a wide result set cannot
 *     make the whole transcript scroll sideways.
 *   - **Images** that open full size, and **links** that cannot reach back
 *     into the opener.
 *
 * ## Untrusted by construction
 *
 * No `rehype-raw`. Inline HTML in the markdown stream is *not* parsed into live
 * DOM — it renders as text. That is the single most important line in this
 * file: with it, a model (or anything steering it) could emit an `<img
 * onerror>` or a form posting to an attacker, on a page that is same-origin
 * with a server that runs shell commands. HTML gets rendered only inside the
 * sandboxed frame, only from an explicit ```html block, and only with scripts
 * off unless the reader turns them on.
 *
 * @module shared/ui/MarkdownRenderer
 */

import React from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { CodeBlock } from './CodeBlock';
import { Widget } from './Widget';
import { rendererFor, widgetForLanguage } from './widget-registry';

export interface MarkdownRendererProps {
  content: string;
  /**
   * True while the text is still arriving. Blocks that cannot be parsed until
   * complete — diagrams especially — wait rather than flashing errors.
   */
  streaming?: boolean;
  /**
   * Ask the agent to repair a widget that failed to render.
   *
   * Threaded through rather than reached for globally, because these
   * components also render where there is no agent — an export, a test — and a
   * Fix button that does nothing is worse than none.
   */
  onFix?: (request: { kind: string; source: string; error: string }) => void;
  /**
   * Corrections to draw in place of the blocks they repair.
   *
   * A projection over the transcript rather than an edit to it — see
   * `web/src/widget-fixes.ts`. `replaced` swaps a broken source for its
   * correction where the broken one stands; `superseded` suppresses the
   * correction's own copy further down, so the same chart is never on screen
   * twice with the reader guessing which is live.
   */
  widgetFixes?: {
    replaced: (source: string) => string | undefined;
    superseded: (source: string) => boolean;
  };
}

// Which fences draw, and what draws them, now live in the widget registry —
// one list, shared with the prompt that tells the model they exist. The sets
// that used to be here said nothing to the server, so a kind could be added in
// one place and be missing from the other with nothing to report it.

export const MarkdownRenderer = React.memo(function MarkdownRenderer({
  content, streaming = false, onFix, widgetFixes,
}: MarkdownRendererProps): React.ReactElement {
  /**
   * Built once per distinct set of props, not once per render.
   *
   * react-markdown reconciles by component identity, so a map rebuilt every
   * render presents a *new component type* at each block's position — and
   * React responds by unmounting and remounting it. A chart re-initialised
   * from scratch is the flicker; a widget you had hidden coming back is the
   * same event with its state thrown away.
   *
   * Streaming is in the dependencies because it genuinely changes what the
   * blocks do; the other two are stable by construction at the call site.
   */
  const components = React.useMemo((): Components => ({
    code({ className, children, ...props }: CodeProps) {
      const language = /language-(\w+)/.exec(className ?? '')?.[1] ?? '';
      const text = String(children);

      // react-markdown 9 no longer passes an `inline` flag, so it is
      // derived: a fenced block always carries a `language-` class or
      // spans lines, and `code` in running prose does neither. Trusting
      // the removed prop rendered every inline mention as a full block
      // with its own toolbar, which is how this was noticed.
      const isBlock = Boolean(language) || text.includes(String.fromCharCode(10));

      if (!isBlock) {
        return (
          // Inline code styling lives in theme.css so it stays
          // consistent with prose that never reaches this component.
          <code {...props}>
            {children}
          </code>
        );
      }

      const raw = text.replace(/\n$/, '');

      const kind = widgetForLanguage(language);
      const Render = kind && rendererFor(kind);
      if (!kind || !Render) return <CodeBlock code={text} language={language} />;

      // A block that *is* somebody's correction has already been drawn in
      // the place it repairs. Showing it again here would put the same
      // chart on screen twice with nothing to say which one counts.
      //
      // Only framed kinds can be corrected — the offer to repair lives on
      // the frame — so only they can supersede anything.
      if (kind.framed && widgetFixes?.superseded(raw)) {
        return (
          <p className="my-2 text-[11px] text-aico-muted">
            ↑ corrected {language} applied above
          </p>
        );
      }

      // Drawn in place of the block that failed. The log still holds the
      // broken source; only what is rendered changes.
      const body = widgetFixes?.replaced(raw) ?? raw;
      const drawn = <Render source={body} streaming={streaming} language={language} />;

      // The frame carries copy, download, expand, hide and the offer to
      // repair, so a chart and a table present the same controls. The
      // kinds that opt out predate it and bring their own chrome; giving
      // them the frame as well would double the border.
      return kind.framed ? (
        <Widget kind={kind.id} source={body} extension={kind.extension} onFix={onFix}>
          {drawn}
        </Widget>
      ) : drawn;
    },

    // react-markdown wraps block code in <pre>; the block components above
    // bring their own chrome, so a second frame around them would double
    // the border and the background.
    pre({ children }) {
      return <>{children}</>;
    },

    table({ children }) {
      // The scroll container is the table's own, never the page's: a wide
      // result set must not make the whole transcript scroll sideways.
      return (
        <div className="my-4 overflow-x-auto">
          <table>{children}</table>
        </div>
      );
    },
    a({ href, children }) {
      const external = /^https?:\/\//i.test(href ?? '');
      return (
        <a
          href={href}
          // `noopener` severs `window.opener`, so a linked page cannot
          // navigate this tab; `noreferrer` keeps the local URL out of
          // the destination's logs.
          {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          className="underline-offset-2"
        >
          {children}
        </a>
      );
    },

    img({ src, alt }) {
      return (
        <a href={typeof src === 'string' ? src : undefined} target="_blank" rel="noopener noreferrer">
          <img
            src={typeof src === 'string' ? src : undefined}
            alt={alt ?? ''}
            loading="lazy"
            className="my-3 max-h-[28rem] max-w-full rounded-xl border border-aico-border-subtle"
          />
        </a>
      );
    },

    input({ checked, type }) {
      // GFM task lists. Read-only: a checkbox in a transcript records
      // what the model wrote, and clicking it would change nothing.
      if (type !== 'checkbox') return null;
      return (
        <input
          type="checkbox"
          checked={Boolean(checked)}
          readOnly
          className="mr-1.5 translate-y-[1px] accent-aico-accent"
        />
      );
    },
  }), [streaming, onFix, widgetFixes]);

  return (
    <div className="markdown-body text-sm leading-relaxed text-aico-primary">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        // `throwOnError: false` matters: a model mid-derivation emits TeX that
        // is briefly invalid, and a thrown error would take down the whole
        // message rather than one formula.
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false, output: 'html' }]]}
        components={components}      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

interface CodeProps extends React.HTMLAttributes<HTMLElement> {
  className?: string;
  children?: React.ReactNode;
}
