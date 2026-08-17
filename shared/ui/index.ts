/**
 * The presentational half of the browser client.
 *
 * Everything exported here is prop-driven and store-free on purpose. That is
 * the whole contract: these render a turn, they do not know how the turn got
 * there. The client feeds them from an SSE stream today; nothing in here has an
 * opinion about that, which is what keeps the transcript renderable from a
 * replayed log as readily as from a live one.
 *
 * Kept out of `web/src` for the same reason: these are the *view*, and the
 * boundary is worth a directory. A component that reached into the store to
 * find out whether a turn was still running would be one refactor away from
 * being unrenderable anywhere else.
 *
 * @module shared/ui
 */

export type { ChatMessage, MessageType, UsageSummary } from './types';
export { EMPTY_USAGE } from './types';
export { MarkdownRenderer } from './MarkdownRenderer';
export { CodeBlock } from './CodeBlock';
export { Diagram } from './Diagram';
export { HtmlPreview } from './HtmlPreview';
export { HIGHLIGHT_LANGUAGES, LANGUAGE_LABELS } from './languages';
export { ReasoningBlock } from './ReasoningBlock';
export { FileDiff, changeFromArgs } from './FileDiff';
export { ToolCallCard } from './ToolCallCard';
export { formatResult } from './tool-result';
export { MessageBubble } from './MessageBubble';
