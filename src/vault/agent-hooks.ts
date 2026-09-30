/**
 * What `runAgent` does with the vault on the way in and on the way out.
 *
 * On the way in: the user's message is scanned (setting `vault.scanUserMessages`,
 * on by default) and any secret in it is vaulted and replaced by a reference
 * before the prompt hooks, the title, the log or the model see it.
 *
 * On the way out: every callback a caller registered — tool start and done,
 * streamed text and reasoning, notices, questions — is wrapped so what it
 * receives has passed the redactor. Callers are the terminal UI, the server's
 * stream, the background registry, the sub-agent registry; wrapping here
 * covers all of them, including ones written later.
 *
 * Structural types only, so this module does not import the agent loop.
 *
 * @module vault/agent-hooks
 */

import { getVault } from './index.js';
import { sinkRedact, sinkRedactAccumulated, sinkRedactText } from './sink.js';

interface RunCallbacks {
  task: string;
  depth?: number;
  sessionId?: string;
  settings?: { vault?: { scanUserMessages?: boolean } } | undefined;
  onToolCall?: (name: string, args: Record<string, unknown>, callId: string) => void;
  onToolDone?: (name: string, result: unknown, callId: string) => void;
  onChunk?: (text: string) => void;
  onReasoning?: (text: string, step: number) => void;
  onNotice?: (text: string) => void;
  onAskUser?: (question: string) => Promise<string>;
}

/** Whether user text should be scanned under these settings. */
export function scanningEnabled(settings: RunCallbacks['settings']): boolean {
  return settings?.vault?.scanUserMessages !== false;
}

/**
 * Vault what a person typed, if scanning is on. Never throws: a scan that
 * fails leaves the text as it was rather than losing the message.
 */
export async function quarantineIfEnabled(
  text: string,
  settings: RunCallbacks['settings'],
  sessionId?: string,
): Promise<{ text: string; stored: Array<{ name: string; kind: string; label: string }>; dropped: number }> {
  if (!scanningEnabled(settings) || !text) return { text, stored: [], dropped: 0 };
  try {
    return await getVault().quarantineUserText(text, sessionId ? { sessionId } : {});
  } catch {
    return { text, stored: [], dropped: 0 };
  }
}

/** Options with the user's message quarantined and every outward callback redacted. */
export async function guardAgentRun<T extends RunCallbacks>(opts: T): Promise<T> {
  let task = opts.task;
  if ((opts.depth ?? 0) === 0) {
    const q = await quarantineIfEnabled(task, opts.settings, opts.sessionId);
    task = q.text;
  }
  const o = opts;
  return {
    ...opts,
    task,
    ...(o.onToolCall ? { onToolCall: (n: string, a: Record<string, unknown>, id: string) => o.onToolCall!(n, sinkRedact(a), id) } : {}),
    ...(o.onToolDone ? { onToolDone: (n: string, r: unknown, id: string) => o.onToolDone!(n, sinkRedact(r), id) } : {}),
    ...(o.onChunk ? { onChunk: (t: string) => o.onChunk!(sinkRedactAccumulated(t)) } : {}),
    ...(o.onReasoning ? { onReasoning: (t: string, step: number) => o.onReasoning!(sinkRedactAccumulated(t), step) } : {}),
    ...(o.onNotice ? { onNotice: (t: string) => o.onNotice!(sinkRedactText(t)) } : {}),
    ...(o.onAskUser ? { onAskUser: (q: string) => o.onAskUser!(sinkRedactText(q)) } : {}),
  };
}
