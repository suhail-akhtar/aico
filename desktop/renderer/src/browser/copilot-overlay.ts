/**
 * The main window's side of the floating copilot.
 *
 * A floating copilot is not drawn here: the page is a native view above this
 * interface, so it would be hidden underneath. It is a view of its own laid
 * over the page (electron/browser-overlay.ts, showing copilot-main.tsx). This
 * window says when it floats, when it may be seen and over which area; hands
 * the conversation's stream to it while it floats and takes it back when it
 * docks or hides; and passes on what only this window hears — an "Ask AICO"
 * prefill, a focus request — and does what only it can (open a chat in the
 * main view).
 *
 * @module desktop/renderer/browser/copilot-overlay
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke, on } from '@/desktop';
import { openChat } from '@/chat/actions';
import type { OverlayMessage, OverlayRequest, OverlayStill } from '@desk/copilot-float';
import { useCopilotUi } from './copilot-ui';
import { attachCopilot, detachCopilot } from './copilot-session';
import { browserElsewhere } from './host';

function relay(m: OverlayMessage): void {
  void invoke('browser:overlay:relay', m).catch(() => {});
}

let installed = false;

/**
 * Prefills and focus requests go to the floating copilot while it floats; "open in main chat" comes back.
 * Installed at boot as well, so the AICO window hears "open in main chat" while the browser is in its own window.
 */
export function installCopilotRelay(): void {
  if (installed) return;
  installed = true;
  const floats = (): boolean => useCopilotUi.getState().mode === 'float';
  useCopilotUi.subscribe((s, prev) => {
    if (s.prefill && s.prefill !== prev.prefill && floats()) relay({ type: 'prefill', text: s.prefill.text, at: s.prefill.at });
  });
  window.addEventListener('aico:copilot-focus', () => { if (floats()) relay({ type: 'focus' }); });
  on<OverlayMessage>('browser:overlay:message', (m) => {
    if (m?.type === 'openChat' && m.sessionId) void openChat(m.sessionId);
  });
}

/**
 * Drive the floating copilot's view from the browser pane.
 *
 * `active`: the copilot floats here (its view holds the conversation). `show`:
 * nothing of this window covers the page, so the view may be on screen. When
 * a cover hides it, the reply carries a still of it, returned here to draw in
 * its place under the menu. `enabled` is false in the side dock, which never
 * floats the copilot but still needs the conversation attached.
 */
export function useFloatingCopilot(area: React.RefObject<HTMLElement | null>, opts: { enabled: boolean; active: boolean; show: boolean }): OverlayStill | null {
  const { enabled } = opts;
  const active = enabled && opts.active;
  const open = useCopilotUi(s => s.open);
  const [still, setStill] = useState<OverlayStill | null>(null);
  const onScreen = useRef(false);

  useEffect(installCopilotRelay, []);

  // One document holds the stream: the overlay while it floats, this window otherwise.
  useEffect(() => {
    if (active) detachCopilot();
    else if (open) attachCopilot();
  }, [active, open]);

  useLayoutEffect(() => {
    const el = area.current;
    if (!enabled || !el) return;
    let frame = 0;
    const push = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        const show = opts.show && r.width > 0 && r.height > 0;
        const capture = onScreen.current && active && !show;
        onScreen.current = active && show;
        const req: OverlayRequest = { active, show, area: { x: r.left, y: r.top, width: r.width, height: r.height }, capture };
        void invoke<{ still?: OverlayStill }>('browser:overlay:set', req)
          .then((res) => { if (res?.still) setStill(res.still); })
          .catch(() => {});
      });
    };
    push();
    const ro = new ResizeObserver(push);
    ro.observe(el);
    window.addEventListener('resize', push);
    // Re-assert now and then while it floats. Main can hide the view on its own (a hand-over) or
    // lose it (the overlay reloaded); pushing only on changes meant nothing ever brought it back.
    const beat = active ? window.setInterval(push, 2000) : 0;
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener('resize', push);
      if (beat) window.clearInterval(beat);
    };
  }, [enabled, active, opts.show]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (opts.show || !active) setStill(null); }, [opts.show, active]);

  // Leaving the browser: the view goes, and this window takes the conversation back.
  useEffect(() => () => {
    if (!enabled) return;
    onScreen.current = false;
    void invoke('browser:overlay:set', { active: false, show: false, area: null } satisfies OverlayRequest).catch(() => {});
    // Leaving because the browser went to its own window: that window holds the conversation now.
    if (browserElsewhere()) detachCopilot();
    else if (useCopilotUi.getState().open) attachCopilot();
  }, [enabled]);

  return active && !opts.show ? still : null;
}
