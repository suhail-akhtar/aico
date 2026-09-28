/**
 * The loading screen — and what it becomes if the engine will not start.
 *
 * The window opens at once (the interface is served by the app, not the
 * engine), and this sits over it until the engine answers: a calm logo and a
 * line that says what is happening. If the engine crashes, it says so, shows
 * the last lines it printed, and offers a restart instead of spinning forever.
 *
 * @module desktop/renderer/shell/EngineGate
 */

import React, { useEffect, useState } from 'react';
import { useDesk } from '@/state/desk';
import { desktop } from '@/desktop';
import { Logo } from './Sidebar';
import { Icon } from '@/lib/icons';

const STEPS = ['Starting the AICO engine', 'Loading skills and tools', 'Connecting to your providers', 'Opening your projects'];

export function EngineGate({ ready }: { ready: boolean }): React.ReactElement | null {
  const engine = useDesk(s => s.engine);
  const [step, setStep] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [leaving, setLeaving] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    if (ready) return;
    const t = setInterval(() => setStep(s => Math.min(STEPS.length - 1, s + 1)), 900);
    return () => clearInterval(t);
  }, [ready]);

  useEffect(() => {
    if (engine.status === 'crashed') void desktop.engine.log().then(setLog).catch(() => {});
  }, [engine]);

  useEffect(() => {
    if (!ready) { setGone(false); setLeaving(false); return; }
    setLeaving(true);
    const t = setTimeout(() => setGone(true), 260);
    return () => clearTimeout(t);
  }, [ready]);

  if (gone) return null;
  const crashed = engine.status === 'crashed';

  return (
    <div className="drag fixed inset-0 z-[90] flex items-center justify-center bg-aico-bg transition-opacity duration-300"
      style={{ opacity: leaving ? 0 : 1 }} aria-busy={!ready} aria-live="polite">
      <div className="no-drag flex w-[440px] max-w-[90vw] flex-col items-center text-center">
        <div className={crashed ? '' : 'animate-pulse-soft'}><Logo size={56} /></div>
        <div className="mt-5 text-[22px] font-semibold tracking-tight">AICO</div>
        {!crashed ? (
          <>
            <div className="mt-6 h-1 w-48 overflow-hidden rounded-full bg-aico-hover">
              <div className="h-full rounded-full bg-aico-accent transition-all duration-700" style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} />
            </div>
            <div className="mt-3 text-[13px] text-aico-muted">{STEPS[step]}…</div>
            {engine.status === 'starting' && engine.attempt > 1 && (
              <div className="mt-2 text-[12px] text-aico-warning">Retrying (attempt {engine.attempt})</div>
            )}
          </>
        ) : (
          <>
            <div className="mt-5 flex items-center gap-2 text-[14px] font-medium text-aico-danger"><Icon name="alert" size={16} /> The engine stopped</div>
            <p className="mt-2 text-[13px] text-aico-secondary">It restarts on its own in {Math.round(engine.retryInMs / 1000)}s. Your chats are safe on disk.</p>
            {log.length === 0 && <p className="mt-2 whitespace-pre-wrap text-[12px] text-aico-muted selectable">{engine.message}</p>}
            {log.length > 0 && (
              <pre className="mt-4 max-h-48 w-full overflow-auto rounded-xl border border-aico-border-subtle bg-aico-code p-3 text-left font-mono text-[11px] text-aico-secondary selectable">
                {log.slice(-25).join('\n')}
              </pre>
            )}
            <div className="mt-4 flex gap-2">
              <button className="btn-primary" onClick={() => void desktop.engine.restart()}>Restart now</button>
              <button className="btn-outline" onClick={() => void navigator.clipboard.writeText(log.join('\n'))}>Copy log</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
