/**
 * The main window's half of a copilot hand-off: a toast with Open.
 *
 * When the browser copilot hands work to a full chat (its `HandOffToChat`
 * tool, or the composer's button), the engine publishes it on the
 * `chat-handoff` topic (src/server/chat-handoff.ts). The copilot draws its own
 * card; this is for the person whose eyes are on the main window — the copilot
 * may be floating over the page, or the browser may be in a window of its own
 * — so they see that a chat started and can jump to it. Subscribed once, at
 * boot, in the main window only.
 *
 * No replay: a hand-off missed while disconnected is in the sidebar anyway,
 * and a toast for something that happened minutes ago is noise.
 *
 * @module desktop/renderer/browser/handoff-toasts
 */

import { streamHandOffs } from '@web/api';
import { useStore } from '@web/store';
import { openChat } from '@/chat/actions';
import { useDesk } from '@/state/desk';

let installed = false;

export function installHandOffToasts(): void {
  if (installed) return;
  installed = true;
  streamHandOffs((event) => {
    if (event.type !== 'handoff' || !event.data?.sessionId) return;
    const h = event.data;
    void useStore.getState().refreshSessions();
    useDesk.getState().toast({
      kind: 'success',
      title: h.existing ? (h.queued ? 'Queued in chat' : 'Sent to chat') : 'Continued in chat',
      body: h.title,
      action: { label: 'Open', run: () => void openChat(h.sessionId) },
      ttl: 15_000,
    });
  });
}
