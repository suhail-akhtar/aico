/**
 * Session log — the append-only source of truth for what the model has seen.
 *
 * The governing invariant is **model-visible means logged**: anything that
 * reaches a model request must be reconstructable from these events. Every
 * request is derived from the log rather than mirrored alongside it, which is
 * what makes the prefix byte-stable enough to cache, the run faithfully
 * resumable, and compaction non-destructive.
 *
 * Adding a new kind of model-visible input therefore means adding an event type
 * here, not threading another string through the agent loop.
 *
 * @module session
 */

export type {
  InboxTarget,
  MessageSource,
  QueuedMessage,
  RequestHeader,
  Seq,
  SessionEvent,
  SessionEventMap,
  SessionEventType,
  SurfaceOp,
  TurnEndReason,
  Usage,
} from './events.js';
export {
  SURFACE_EVENT_TYPES,
  formatTurnEndReason,
  isSurfaceEvent,
} from './events.js';

export type { DeriveRepairs, DeriveResult } from './derive.js';
export {
  MISSING_RESULT_TEXT,
  computeShadowedSeqs,
  deriveMessages,
  deriveMessagesDetailed,
} from './derive.js';

export type { AppendOptions, SessionHeader, SessionListener } from './session.js';
export { Session, canonicalHeader, headerEquals } from './session.js';

export {
  EVENT_LOG_VERSION,
  eventLogPath,
  initEventLog,
  listEventLogs,
  loadEventLog,
  persistSession,
} from './persistence.js';

export type { InvariantReport, InvariantViolation } from './invariant.js';
export { assertSessionInvariants, checkSessionInvariants } from './invariant.js';

export type { OpenSession } from './open.js';
export { openSession, seedFromLegacyHistory } from './open.js';

export type { InboxListener, InboxSnapshot } from './inbox.js';
export { Inbox } from './inbox.js';

export type { SessionCompactionResult } from './compact.js';
export {
  describeSessionContext,
  formatCompactionResult,
  maybeCompactSession,
  serializeSessionTranscript,
} from './compact.js';

export type { Transcript, SessionTranscriptOptions } from './transcript.js';
export { LegacyTranscript, SessionTranscript } from './transcript.js';
