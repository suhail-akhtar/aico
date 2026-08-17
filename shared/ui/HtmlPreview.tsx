/**
 * Rendering an HTML block the model produced.
 *
 * This is the most dangerous thing in the renderer, so the defaults are the
 * strict ones and the reasoning is written down.
 *
 * **The HTML is untrusted.** Not "probably fine" — untrusted. It is model
 * output, and model output is steerable by anything that reached the context:
 * a file the agent read, a web page it fetched, a tool result. Treating it as
 * trusted markup would mean any of those could put a credential form or a
 * exfiltrating script onto a page that is same-origin with a local server that
 * runs shell commands.
 *
 * So it renders inside an iframe with:
 *
 *   - **`sandbox` with neither `allow-same-origin` nor, by default,
 *     `allow-scripts`.** Without `allow-same-origin` the frame gets an opaque
 *     origin: no access to our cookies, storage, or DOM, and no reading of the
 *     token in `sessionStorage`. Granting both together is equivalent to no
 *     sandbox at all, so this component never does — even when scripts are
 *     enabled, `allow-same-origin` stays off.
 *   - **`srcdoc` rather than a blob URL**, so nothing is ever added to our
 *     origin's URL space.
 *   - **Scripts off until asked.** Static markup covers almost every case a
 *     model produces — a table, a styled card, a small layout. Running scripts
 *     is a separate, explicit, per-block decision.
 *   - **A visible source toggle.** Anyone can read the markup before deciding
 *     to render it, which is the only real defence against a preview that looks
 *     innocuous and is not.
 *
 * The frame cannot navigate the top window (`allow-top-navigation` is absent),
 * cannot open popups, and cannot submit forms.
 *
 * @module shared/ui/HtmlPreview
 */

import React, { useMemo, useState } from 'react';

export interface HtmlPreviewProps {
  html: string;
  /** Label shown on the toolbar. */
  language?: string;
}

/** Height the frame starts at before its content reports a size. */
const DEFAULT_HEIGHT = 240;
const MAX_HEIGHT = 900;

/**
 * Per-block view choices, kept outside React.
 *
 * Component state is lost on remount, and the transcript remounts constantly
 * while a later message streams — so a block flipped to Source would silently
 * flip back, and enabling scripts would silently disable them again. Keyed by
 * the html itself, which is what identifies the block.
 */
const sourceShown = new Set<string>();
const scriptsAllowed = new Set<string>();

export const HtmlPreview = React.memo(function HtmlPreview({
  html, language = 'html',
}: HtmlPreviewProps): React.ReactElement {
  const [showSource, setShowSource] = useState(() => sourceShown.has(html));
  const [allowScripts, setAllowScripts] = useState(() => scriptsAllowed.has(html));
  const [height, setHeight] = useState(DEFAULT_HEIGHT);

  const toggleSource = (): void => setShowSource(current => {
    const next = !current;
    if (next) sourceShown.add(html); else sourceShown.delete(html);
    return next;
  });
  const toggleScripts = (next: boolean): void => {
    if (next) scriptsAllowed.add(html); else scriptsAllowed.delete(html);
    setAllowScripts(next);
  };

  // `allow-same-origin` is deliberately never included. With it, the frame
  // could reach into this page — including the session token — which would make
  // the sandbox decorative.
  const sandbox = allowScripts ? 'allow-scripts' : '';

  const document = useMemo(() => wrapDocument(html, allowScripts), [html, allowScripts]);

  return (
    <figure className="group/html my-4 overflow-hidden rounded-xl border border-aico-border-subtle">
      <figcaption className="flex items-center gap-2 bg-aico-code px-4 py-2 text-[12px] text-aico-muted">
        <span>{language}</span>
        <div className="flex-1" />

        <button
          onClick={toggleSource}
          className="rounded px-2 py-0.5 text-[12px] text-aico-muted hover:text-aico-primary"
        >
          {showSource ? 'Preview' : 'Source'}
        </button>

        <label
          className="flex cursor-pointer items-center gap-1 text-xs text-aico-muted hover:text-aico-secondary"
          title="Run scripts in an isolated frame. The frame still has no access to this page, its storage, or its session token."
        >
          <input
            type="checkbox"
            checked={allowScripts}
            onChange={e => toggleScripts(e.target.checked)}
            className="accent-aico-accent"
          />
          scripts
        </label>
      </figcaption>

      {showSource ? (
        <pre className="max-h-[28rem] overflow-auto bg-aico-code px-4 pb-4 font-mono text-[13px] leading-[22px] text-aico-primary">
          <code>{html}</code>
        </pre>
      ) : (
        <iframe
          // Remounted when the sandbox changes: a frame's sandbox attribute is
          // only read at load, so toggling it on a live frame does nothing.
          key={sandbox}
          title="HTML preview"
          sandbox={sandbox}
          srcDoc={document}
          referrerPolicy="no-referrer"
          onLoad={event => setHeight(measure(event.currentTarget))}
          style={{ height }}
          className="w-full border-0 bg-white"
        />
      )}

      {allowScripts && !showSource && (
        <div className="border-t border-aico-warning/25 bg-aico-warning/8 px-4 py-1.5 text-[12px] text-aico-warning">
          Scripts are running in an isolated frame. It cannot read this page or your session.
        </div>
      )}
    </figure>
  );
});

/**
 * Wrap a fragment in a minimal document.
 *
 * A model usually emits a fragment rather than a whole document, and a bare
 * fragment in `srcdoc` inherits nothing — no charset, no sane defaults — so it
 * renders as unstyled serif text on white and looks broken. The wrapper also
 * carries a restrictive CSP as a second layer: even with `allow-scripts` on,
 * the frame cannot reach the network to fetch code or exfiltrate anything.
 */
function wrapDocument(html: string, allowScripts: boolean): string {
  // Only `data:` and inline are permitted; `connect-src 'none'` means a script
  // that does run cannot phone home with whatever it found.
  const csp = [
    "default-src 'none'",
    "img-src data: blob:",
    "style-src 'unsafe-inline'",
    "font-src data:",
    allowScripts ? "script-src 'unsafe-inline'" : "script-src 'none'",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');

  // A complete document is used as-is apart from the CSP, since overriding an
  // author's <head> would break the thing we are trying to show.
  if (/<html[\s>]/i.test(html)) {
    return html.replace(/<head[^>]*>/i, match => `${match}\n<meta http-equiv="Content-Security-Policy" content="${csp}">`);
  }

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root { color-scheme: light; }
  body { margin: 12px; font: 14px/1.5 system-ui, -apple-system, sans-serif; color: #1a1a1a; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; }
  img, svg, video { max-width: 100%; height: auto; }
  pre { overflow-x: auto; }
</style>
</head>
<body>${html}</body>
</html>`;
}

/**
 * Fit the frame to its content.
 *
 * Reading `contentDocument` only works while the frame has no `allow-scripts`
 * *and* no `allow-same-origin` — an opaque-origin document is unreadable from
 * here either way, so this is best-effort and falls back to a fixed height
 * rather than pretending to know.
 */
function measure(frame: HTMLIFrameElement): number {
  try {
    const body = frame.contentDocument?.body;
    if (!body) return DEFAULT_HEIGHT;
    const measured = Math.max(body.scrollHeight, body.offsetHeight) + 24;
    return Math.min(Math.max(measured, 80), MAX_HEIGHT);
  } catch {
    return DEFAULT_HEIGHT;
  }
}
