/**
 * What the log knows about the provider's cache.
 *
 * A prompt cache hits when the prefix — tools, system prompt, transcript — is
 * byte-identical to the last request's. The loop records a `request/header`
 * whenever the cacheable part of the request changes, with a hash per prompt
 * section and the sorted tool list; the provider reports how much of each
 * request was read from cache. Reading both back answers two questions a
 * reader cannot otherwise answer: *how much* of the conversation is being paid
 * for again, and *what moved* when it was.
 *
 * Nothing here calls a model or costs a token; it is a projection over events
 * that are already in the log.
 *
 * @module session/cache
 */

import type { Session } from './session.js';
import type { RequestHeader, SessionEventMap, Seq } from './events.js';

/** One prefix change: what differed from the request before it. */
export interface CacheReset {
  seq: Seq;
  /** Sections whose rendered bytes changed, by id. Empty when only tools or the route moved. */
  sections: string[];
  toolsAdded: string[];
  toolsRemoved: string[];
  /** The model or provider changed — a different cache altogether. */
  route: boolean;
}

/**
 * Every prefix change after the first header, oldest first.
 *
 * The first header of a session (or of a resumed loop) is not a reset: nothing
 * was cached before it. Headers older than `sinceSeq` are still consulted as
 * the "previous" state, so asking about one turn attributes a change correctly
 * even when the last header before it was turns ago.
 */
export function cacheResets(session: Session, sinceSeq = 0): CacheReset[] {
  const out: CacheReset[] = [];
  let previous: RequestHeader | undefined;
  for (const event of session.events) {
    if (event.type !== 'request/header') continue;
    const { header, reason } = event.data as SessionEventMap['request/header'];
    if (previous && reason === 'change' && event.seq >= sinceSeq) {
      out.push(diffHeaders(previous, header, event.seq));
    }
    previous = header;
  }
  return out;
}

function diffHeaders(before: RequestHeader, after: RequestHeader, seq: Seq): CacheReset {
  const sections: string[] = [];
  const a = before.sectionHashes ?? {};
  const b = after.sectionHashes ?? {};
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[id] !== b[id]) sections.push(id);
  }
  // With no per-section hashes on either side, the only evidence is the
  // whole-prompt hash — say so rather than saying nothing changed.
  if (sections.length === 0 && before.systemHash !== after.systemHash
      && !before.sectionHashes && !after.sectionHashes) {
    sections.push('system_prompt');
  }
  const beforeTools = new Set(before.tools);
  const afterTools = new Set(after.tools);
  return {
    seq,
    sections: sections.sort(),
    toolsAdded: after.tools.filter(t => !beforeTools.has(t)),
    toolsRemoved: before.tools.filter(t => !afterTools.has(t)),
    route: before.model !== after.model || before.provider !== after.provider,
  };
}

/** One reset in words: "prefix changed: remembered, project_instructions; tools: +VerifyApp". */
export function describeReset(reset: CacheReset): string {
  const parts: string[] = [];
  if (reset.route) parts.push('model changed');
  if (reset.sections.length) parts.push(`prefix changed: ${reset.sections.join(', ')}`);
  const tools = [
    ...reset.toolsAdded.map(t => `+${t}`),
    ...reset.toolsRemoved.map(t => `-${t}`),
  ];
  if (tools.length) parts.push(`tools: ${tools.slice(0, 6).join(' ')}${tools.length > 6 ? ` (+${tools.length - 6})` : ''}`);
  return parts.join('; ') || 'prefix changed';
}

/** Cached input over all input, for the events in range; 0 when nothing was reported. */
export function cacheShare(session: Session, fromSeq = 0, toSeq = Number.MAX_SAFE_INTEGER): number {
  let input = 0;
  let cached = 0;
  for (const event of session.events) {
    if (event.seq < fromSeq || event.seq > toSeq || event.type !== 'assistant/message') continue;
    const usage = (event.data as { usage?: { inputTokens?: number; cachedTokens?: number } }).usage;
    if (!usage) continue;
    input += usage.inputTokens ?? 0;
    cached += usage.cachedTokens ?? 0;
  }
  return input > 0 ? cached / input : 0;
}
