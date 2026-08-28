/**
 * Editing something you already sent, in a log that cannot be edited.
 *
 * Rewording a question and asking again is the most ordinary thing in a chat,
 * and doing it by hand means copying the message, scrolling to the bottom,
 * pasting, editing, sending — and then reading a transcript that contains both
 * attempts and all of both answers, with nothing saying which one you meant.
 *
 * The log stays append-only. A re-send is a new message that *names the one it
 * replaces*, and this reads those pairings back into versions. Exactly the
 * mechanism {@link module:widget-fixes} uses, because it is the same problem:
 * the record must not change, and what is drawn must.
 *
 * ## What a version owns
 *
 * A version is not just the text — it is the text **and everything that came
 * back from it**. Version 1 owns the replies between the original and the first
 * re-send; version 2 owns everything after that re-send, until the next one.
 * Switching versions therefore swaps a stretch of conversation, not a bubble,
 * which is the whole point: an answer to a question you rephrased is not an
 * answer to the question you asked.
 *
 * ## Why the newest is shown
 *
 * You edited because the first attempt was wrong. Landing on it and having to
 * click forward would be backwards.
 *
 * @module message-versions
 */

import type { ChatMessage } from '@aico/ui';

/** Marker written into a re-send. Stripped before the message is shown. */
const MARKER = /\[\[aico:edit:(\d+)\]\]/;

/** The log seq encoded in a finalized message's id, if it has one. */
export function seqOf(id: string): number | null {
  const match = /^seq-(\d+)$/.exec(id);
  return match ? Number(match[1]) : null;
}

/** The marker appended to a re-send, naming the message it replaces. */
export function editMarker(originalSeq: number): string {
  return `[[aico:edit:${originalSeq}]]`;
}

/** Remove the marker so the reader never sees the plumbing. */
export function stripEditMarker(text: string): string {
  return text.replace(MARKER, '').trimEnd();
}

export interface MessageVersion {
  /** What was asked on this attempt. */
  content: string;
  /** Index of the message carrying it, so its own actions still work. */
  index: number;
}

export interface VersionGroup {
  /** Index of the original message every version replaces. */
  originalIndex: number;
  /** Seq of that original — what a re-send names. */
  originalSeq: number;
  versions: MessageVersion[];
  /** Message indices owned by each version, by version number. */
  owned: number[][];
}

export interface VersionedView {
  /** Messages to render, in order, after version selection. */
  messages: ChatMessage[];
  /** Version controls, keyed by the id of the message they sit under. */
  groups: Map<string, { total: number; current: number; originalSeq: number }>;
}

/**
 * Group a conversation into edit versions.
 *
 * Returns nothing when no message was ever re-sent, which is almost every
 * conversation — callers can then skip the whole mechanism rather than paying
 * for a rebuild of the list.
 */
export function collectVersionGroups(messages: readonly ChatMessage[]): VersionGroup[] {
  const bySeq = new Map<number, VersionGroup>();

  messages.forEach((message, index) => {
    if (message.type !== 'user') return;
    const marked = MARKER.exec(message.content ?? '');
    if (!marked) return;
    const targetSeq = Number(marked[1]);

    let group = bySeq.get(targetSeq);
    if (!group) {
      const originalIndex = messages.findIndex(m => seqOf(m.id) === targetSeq);
      // A re-send whose original is not in view — scrolled out of a truncated
      // transcript, or a log that starts mid-conversation. It renders as an
      // ordinary message rather than being dropped, which is the safe way to
      // be wrong: a visible message nobody grouped beats a missing one.
      if (originalIndex === -1) return;
      group = {
        originalIndex,
        originalSeq: targetSeq,
        versions: [{
          content: messages[originalIndex]!.content ?? '',
          index: originalIndex,
        }],
        owned: [],
      };
      bySeq.set(targetSeq, group);
    }
    group.versions.push({ content: stripEditMarker(message.content ?? ''), index });
  });

  // What each version owns: everything from its own message up to the start of
  // the next version, excluding the version messages themselves.
  for (const group of bySeq.values()) {
    group.owned = group.versions.map((version, v) => {
      const next = group.versions[v + 1]?.index ?? messages.length;
      const owned: number[] = [];
      for (let i = version.index + 1; i < next; i++) owned.push(i);
      return owned;
    });
  }

  return [...bySeq.values()].sort((a, b) => a.originalIndex - b.originalIndex);
}

/**
 * Apply version choices to a conversation.
 *
 * `selected` holds the version index a reader has navigated to, by original
 * seq. Anything absent shows its newest version, because that is the one just
 * asked for.
 */
export function applyVersions(
  messages: readonly ChatMessage[],
  selected: ReadonlyMap<number, number>,
): VersionedView {
  const groups = collectVersionGroups(messages);
  if (groups.length === 0) {
    return { messages: messages as ChatMessage[], groups: new Map() };
  }

  const hidden = new Set<number>();
  const controls = new Map<string, { total: number; current: number; originalSeq: number }>();
  /** Index of the original → the content to show there instead. */
  const substitute = new Map<number, string>();

  for (const group of groups) {
    const last = group.versions.length - 1;
    const chosen = Math.min(Math.max(selected.get(group.originalSeq) ?? last, 0), last);

    // Every version's own message is hidden except the original's slot, which
    // is where the chosen version is drawn — so the question stays where it was
    // asked rather than jumping to the bottom of the conversation.
    group.versions.forEach((version, v) => {
      if (v > 0) hidden.add(version.index);
      if (v !== chosen) for (const index of group.owned[v] ?? []) hidden.add(index);
    });

    substitute.set(group.originalIndex, group.versions[chosen]!.content);
    controls.set(messages[group.originalIndex]!.id, {
      total: group.versions.length,
      current: chosen,
      originalSeq: group.originalSeq,
    });
  }

  const visible: ChatMessage[] = [];
  messages.forEach((message, index) => {
    if (hidden.has(index)) return;
    const replacement = substitute.get(index);
    visible.push(replacement === undefined ? message : { ...message, content: replacement });
  });

  return { messages: visible, groups: controls };
}
