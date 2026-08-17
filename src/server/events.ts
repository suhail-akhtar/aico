/**
 * The SSE hub: one place that turns engine callbacks into a resumable stream.
 *
 * A browser tab is not a terminal. It gets closed, backgrounded, put to sleep
 * with the laptop lid, and reconnected on a different network — while an agent
 * run that takes ten minutes carries on regardless. So the transport has to
 * answer "what did I miss?", not merely "what is happening now".
 *
 * Two kinds of event flow through here and they have different durability:
 *
 *   **Durable** — anything already in the session log (messages, tool results,
 *   turn boundaries). These have a monotonic `seq`, so a reconnecting client
 *   says `?since=412` and gets exactly the gap.
 *
 *   **Ephemeral** — streaming deltas (text chunks, reasoning). These exist only
 *   while they are being produced. A client that missed them missed them; what
 *   it gets instead is the settled message the deltas were building toward,
 *   which is the part that mattered. Buffering deltas for replay would mean
 *   keeping unbounded per-session state to reproduce an animation.
 *
 * That split is why reconnect is cheap here: the log already is the history, so
 * the hub only has to fan out live events, not remember them.
 *
 * @module server/events
 */

import type { ServerResponse } from 'http';

/** A frame on the wire. `seq` is present only for log-backed events. */
export interface StreamEvent {
  type: string;
  sessionId: string;
  seq?: number;
  data: unknown;
}

interface Subscriber {
  sessionId: string;
  res: ServerResponse;
}

export class EventHub {
  private readonly subscribers = new Set<Subscriber>();

  /**
   * Attach a response as an SSE stream.
   *
   * Returns a detach function. Callers must invoke it on close, or a client
   * that navigates away leaves a writer that throws on every later publish.
   */
  subscribe(sessionId: string, res: ServerResponse): () => void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Proxies that buffer will hold a stream forever waiting for it to end.
      'X-Accel-Buffering': 'no',
    });
    // An immediate comment flushes headers, so the browser fires `onopen` now
    // rather than whenever the first real event happens to arrive.
    res.write(': connected\n\n');

    const sub: Subscriber = { sessionId, res };
    this.subscribers.add(sub);
    return () => { this.subscribers.delete(sub); };
  }

  /** Fan an event out to every stream watching its session. */
  publish(event: StreamEvent): void {
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const sub of this.subscribers) {
      if (sub.sessionId !== event.sessionId) continue;
      try {
        sub.res.write(frame);
      } catch {
        // A dead socket is normal — the tab closed. Drop it rather than let a
        // broken writer fail every future publish for everyone else.
        this.subscribers.delete(sub);
      }
    }
  }

  /**
   * Keep intermediaries from closing an idle connection.
   *
   * A long tool call can leave a stream silent for minutes, which some proxies
   * read as dead. A comment frame is ignored by EventSource but keeps the
   * socket warm.
   */
  heartbeat(): void {
    for (const sub of this.subscribers) {
      try {
        sub.res.write(': ping\n\n');
      } catch {
        this.subscribers.delete(sub);
      }
    }
  }

  /** Close every stream — used on shutdown so the process can exit. */
  closeAll(): void {
    for (const sub of this.subscribers) {
      try { sub.res.end(); } catch { /* already gone */ }
    }
    this.subscribers.clear();
  }

  get size(): number {
    return this.subscribers.size;
  }
}
