/**
 * Repairing a widget where it stands, in an append-only transcript.
 *
 * The log cannot be edited, and should not be: the broken specification is what
 * the agent actually wrote, and a record that quietly improves itself is not a
 * record. But a reader who asks for a fix wants the chart *there*, in the place
 * they were reading, not a corrected copy several messages further down that
 * they have to scroll to and mentally substitute.
 *
 * Both are satisfied the way everything else here is: the log stays exactly as
 * written, and the *projection* over it decides what is drawn. Plans, todos and
 * session titles already work this way.
 *
 * ## How a correction finds its original
 *
 * The Fix request carries a marker naming a hash of the block that failed. The
 * correction is then the first block of the same kind in the assistant message
 * that answers it. That pairing gives two facts:
 *
 *   - the broken block should render as its replacement, in place
 *   - the replacement should *not* also render on its own further down, or the
 *     reader gets the same chart twice and has to work out which is live
 *
 * ## Why the position and not an id from the model
 *
 * Asking the model to echo a correlation id back would be one more thing for it
 * to get wrong, in a path that exists *because* it got something wrong. The
 * request is ours and the reply position is structural, so neither depends on
 * the model cooperating.
 *
 * @module widget-fixes
 */

import type { ChatMessage } from '@aico/ui';
import { widgetById } from '../../shared/widgets/catalog';

/** Marker written into the Fix request. Stripped before the message is shown. */
const MARKER = /\[\[aico:fix:([a-z0-9]+):([a-z]+)\]\]/i;

/**
 * A short, stable hash of a widget's source.
 *
 * FNV-1a: a few lines, no dependency, and stable across reloads — which is what
 * matters, because the request is written in one session and read back from the
 * log in another. Collisions are irrelevant here; the worst case is one chart
 * showing another's correction, in a transcript where both are visible.
 */
export function widgetHash(source: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** The marker line appended to a Fix request. */
export function fixMarker(source: string, kind: string): string {
  return `[[aico:fix:${widgetHash(source)}:${kind}]]`;
}

/** Remove the marker so the reader never sees the plumbing. */
export function stripMarker(text: string): string {
  return text.replace(MARKER, '').trimEnd();
}

/** Whether this message is a repair request rather than something the reader typed. */
export function isFixRequest(text: string): boolean {
  return MARKER.test(text);
}

/** The first fenced block of a given kind in some markdown. */
export function firstBlock(markdown: string, kind: string): string | undefined {
  // Every fence the kind answers to, taken from the catalogue rather than
  // restated here. This was a hardcoded pair of special cases for `chart` and
  // `table`, which meant any kind added later matched only its own name — so a
  // diagram repair asked for ```diagram, the model sensibly replied with
  // ```mermaid, and the correction was never found. The widget sat marked
  // "being fixed" for ever with the answer sitting unread two messages away.
  const aliases = widgetById(kind)?.languages ?? [kind];
  for (const alias of aliases) {
    const pattern = new RegExp('```' + alias + '\\s*\\n([\\s\\S]*?)```', 'i');
    const found = pattern.exec(markdown);
    if (found?.[1]) return found[1].replace(/\n$/, '');
  }
  return undefined;
}

export interface WidgetFixes {
  /** Broken source hash → the corrected source to draw in its place. */
  replacements: Map<string, string>;
  /** Hashes of corrected blocks, which must not also render on their own. */
  superseded: Set<string>;
  /**
   * Indices of the messages that carried a repair, which are not shown.
   *
   * A repair is machinery, not conversation. The request is a paragraph this
   * interface wrote — the failing spec, the parser's error, and an instruction
   * — and the reply is the corrected block, which is already drawn where the
   * broken one stood. Leaving both in the transcript means asking for a fix
   * costs the reader a wall of text they did not write and an answer they can
   * already see, in the middle of whatever they were actually reading.
   *
   * Hidden from the *view* only. The log still holds every word, so the export
   * is complete, the cost is accounted, and a session can be replayed exactly
   * — which is the whole reason drawing is a projection rather than an edit.
   */
  hidden: Set<number>;
}

export const NO_FIXES: WidgetFixes = {
  replacements: new Map(), superseded: new Set(), hidden: new Set(),
};

/**
 * Read the repair pairs out of a conversation.
 *
 * Later corrections win: a widget fixed twice shows the second attempt, which
 * is the one the reader last asked for. That falls out of assigning as we go
 * rather than needing a rule.
 */
export function collectWidgetFixes(messages: readonly ChatMessage[]): WidgetFixes {
  const replacements = new Map<string, string>();
  const superseded = new Set<string>();
  const hidden = new Set<number>();

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.type !== 'user') continue;
    const marked = MARKER.exec(message.content ?? '');
    if (!marked) continue;

    const [, hash, kind] = marked;
    if (!hash || !kind) continue;

    // The request always goes. It is a paragraph this interface wrote, not
    // something the reader typed, and it reads as noise whatever the outcome.
    hidden.add(i);

    // The answer is the next assistant message. Tool calls and results sit
    // between them on almost every turn, so this skips rather than requiring
    // adjacency — but it stops at the next user message, because past that the
    // reader has moved on and a later block is about something else.
    //
    // The span is collected before it is hidden, and only hidden if a
    // correction actually came out of it. Hiding it either way would mean a
    // repair that failed — or that answered "I cannot fix this" — vanished
    // completely, leaving a widget marked as being fixed and no explanation
    // anywhere. Silence is the one outcome worse than noise.
    const span: number[] = [];
    for (let j = i + 1; j < messages.length; j++) {
      const reply = messages[j]!;
      if (reply.type === 'user') break;
      span.push(j);
      if (reply.type !== 'assistant') continue;
      const corrected = firstBlock(reply.content ?? '', kind);
      if (corrected === undefined) continue;
      replacements.set(hash, corrected);
      superseded.add(widgetHash(corrected));
      // Everything the repair turn produced belongs to the repair, including
      // the reasoning and tool calls it made on the way. Hiding only the final
      // answer would leave the working-out behind with nothing to explain it.
      for (const index of span) hidden.add(index);
      break;
    }
  }

  return { replacements, superseded, hidden };
}
