/**
 * The frame every rendered widget sits in, and the actions on it.
 *
 * A chart, a table and a diagram are different things to draw and the same
 * thing to *handle*: you want to see it bigger, copy what produced it, save it,
 * get it out of the way, and — when it does not draw — find out why and have it
 * fixed. Putting that in one place is what stops each renderer inventing its
 * own half of it.
 *
 * ## One bad widget must not take the transcript down
 *
 * Everything here is wrapped in an error boundary, because the alternative is
 * genuinely severe: these render model-authored specifications, a malformed one
 * throws during render, and an unhandled throw in React unmounts the whole
 * tree. One bad chart would blank the conversation that produced it — including
 * the message explaining what went wrong.
 *
 * ## A failure is a repairable state, not a dead end
 *
 * When a widget fails, the frame keeps the source and the error and offers to
 * have them fixed. That is the difference between "widget failed:
 * s.map is not a function" — which a reader can do nothing with — and a button
 * that hands the agent the spec it wrote, the error it caused, and the
 * instruction to correct it.
 *
 * @module shared/ui/Widget
 */

import React, { Component, useState, type ErrorInfo, type ReactNode } from 'react';

export interface WidgetProps {
  /** Shown in the header. Falls back to the kind. */
  title?: string;
  /** What this is — `chart`, `table`, `diagram`. Used in the filename too. */
  kind: string;
  /** The source that produced it, for copying, saving and repair. */
  source: string;
  /** File extension for the download, without the dot. */
  extension?: string;
  /**
   * Ask the agent to repair this widget.
   *
   * Optional because the shared components render in contexts with no agent to
   * ask — a static export, a test. Absent means the Fix action is simply not
   * offered, rather than offered and inert.
   */
  onFix?: (request: { kind: string; source: string; error: string }) => void;
  children: ReactNode;
}

interface BoundaryState { error?: string }

class WidgetBoundary extends Component<
  { children: ReactNode; onError: (message: string) => void },
  BoundaryState
> {
  override state: BoundaryState = {};

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Logged as well as shown: the component stack is what actually locates a
    // failure inside a charting library, and it never reaches the UI.
    console.error('[widget] render failed', error, info.componentStack);
    this.props.onError(error instanceof Error ? error.message : String(error));
  }

  override render(): ReactNode {
    // The frame draws the failure state; this only stops the throw and reports
    // it. Returning null here rather than an error box keeps one place
    // responsible for what a broken widget looks like.
    return this.state.error ? null : this.props.children;
  }
}

function download(name: string, contents: string): void {
  const blob = new Blob([contents], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  // Revoked on the next tick rather than immediately: Safari has not started
  // reading the blob when `click()` returns, and revoking first gives an empty
  // file with no error.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function Widget({
  title, kind, source, extension = 'txt', onFix, children,
}: WidgetProps): React.ReactElement {
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  // Remounts the subtree, which is the only way to retry a render that threw:
  // an error boundary latches, and without a new key the repaired child would
  // never be attempted.
  const [attempt, setAttempt] = useState(0);
  /**
   * Set once a repair has been asked for.
   *
   * The transcript is append-only, so the correction arrives as a *new* widget
   * further down rather than replacing this one — and that is right: the broken
   * spec is what the agent actually wrote, and erasing it would erase the
   * record. What is wrong is leaving this one shouting in red as though nothing
   * had happened, so it stands down and points at where the answer went.
   */
  const [repairing, setRepairing] = useState(false);

  const copy = (): void => {
    void navigator.clipboard.writeText(source).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  const action = 'rounded px-1.5 py-0.5 text-[11px] text-aico-muted transition-colors '
    + 'hover:bg-aico-hover hover:text-aico-primary';

  return (
    <div className={`my-2 overflow-hidden rounded-lg border border-aico-border bg-aico-bg ${
      expanded ? 'fixed inset-4 z-50 my-0 shadow-2xl' : ''}`}>
      <div className="flex items-center gap-1 border-b border-aico-border-subtle px-2 py-1">
        <span className="mr-auto truncate text-[11px] text-aico-secondary">
          {title ?? kind}
          {failure && (
            <span className={`ml-1.5 ${repairing ? 'text-aico-muted' : 'text-aico-danger'}`}>
              {repairing ? '· being fixed' : '· failed to render'}
            </span>
          )}
        </span>

        <button onClick={copy} className={action} title="Copy the source">
          {copied ? 'copied' : 'copy'}
        </button>
        <button
          onClick={() => download(`${kind}-${Date.now()}.${extension}`, source)}
          className={action}
          title="Download the source"
        >
          download
        </button>
        <button
          onClick={() => setExpanded(v => !v)}
          className={action}
          title={expanded ? 'Back into the transcript' : 'Fill the window'}
        >
          {expanded ? 'restore' : 'expand'}
        </button>
        <button
          onClick={() => setCollapsed(v => !v)}
          className={action}
          title={collapsed ? 'Show it again' : 'Hide it'}
        >
          {collapsed ? 'show' : 'hide'}
        </button>
      </div>

      {!collapsed && (
        <div className={expanded ? 'h-[calc(100%-2rem)] overflow-auto p-2' : 'p-2'}>
          {failure ? (
            <div className="space-y-2">
              <p className={`text-[12px] ${repairing ? 'text-aico-muted' : 'text-aico-danger'}`}>
                {repairing
                  ? `Asked the agent to correct this ${kind}. The working version arrives `
                    + 'below — this one stays as the record of what went wrong.'
                  : `This ${kind} did not render: ${failure}`}
              </p>
              <div className="flex items-center gap-1.5">
                {onFix && !repairing && (
                  <button
                    onClick={() => {
                      setRepairing(true);
                      onFix({ kind, source, error: failure });
                    }}
                    className="rounded-lg bg-aico-accent px-2 py-1 text-[11px] font-medium
                               text-white transition-opacity hover:opacity-90"
                  >
                    Fix it
                  </button>
                )}
                <button
                  onClick={() => {
                    setFailure(undefined);
                    setRepairing(false);
                    setAttempt(n => n + 1);
                  }}
                  className={action}
                >
                  try again
                </button>
              </div>
              {/*
                The source is shown, not hidden behind the error. A reader who
                can see the spec can often tell what is wrong with it at a
                glance, and the one who cannot has lost nothing.
              */}
              <pre className="max-h-48 overflow-auto rounded bg-aico-hover p-2 text-[11px]
                              leading-[15px] text-aico-muted">{source}</pre>
            </div>
          ) : (
            <WidgetBoundary key={attempt} onError={setFailure}>{children}</WidgetBoundary>
          )}
        </div>
      )}
    </div>
  );
}
