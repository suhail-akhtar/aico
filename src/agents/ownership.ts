/**
 * Which conversation a sub-agent's session (`sub-<agentId>`) ultimately belongs to.
 *
 * Moved out of `tools/task.ts` so the shell tool can ask the same question
 * without importing the sub-agent machinery: `tools/bash.ts` → `tools/task.ts`
 * → the tool registry → `tools/bash.ts` is a cycle (see `work/register.ts`).
 * A backgrounded command started inside a sub-agent has to be filed under the
 * chat a person is watching, or its exit notice goes nowhere and another chat's
 * `Supervise stop` can reach it.
 *
 * Entries are kept for the life of the process: two short strings each, and
 * dropping one would orphan anything a finished agent had spawned. It is a
 * leaf on purpose — it imports nothing.
 *
 * @module agents/ownership
 */

const OWNER_OF_SUB_SESSION = new Map<string, string>();

/** Record that `sub-<agentId>` belongs to `owner` (a conversation, or another sub session). */
export function recordOwner(subSessionId: string, owner: string): void {
  OWNER_OF_SUB_SESSION.set(subSessionId, owner);
}

/** The conversation a spawn belongs to, climbing out of any nesting. */
export function owningSession(sessionId: string | undefined): string | undefined {
  let current = sessionId;
  // Bounded: a cycle here would be a bug, but an unbounded walk would be a
  // hang, and sub-agent depth is limited to single digits anyway.
  for (let hop = 0; hop < 16 && current; hop++) {
    const owner = OWNER_OF_SUB_SESSION.get(current);
    if (!owner) return current;
    current = owner;
  }
  return current;
}
