/**
 * Provider-adaptive system prompts.
 *
 * A prompt is written **once**, as data, and rendered per provider in whatever
 * shape that vendor documents as best. Nothing in the prompt content knows
 * which provider it is going to; nothing in the rendering knows what the
 * content says. That separation is the whole point — without it, supporting
 * four vendors means four near-copies of the same prompt drifting apart.
 *
 * The vendors genuinely disagree, so this is not over-engineering:
 *
 * | Vendor    | Structure                        | Long-context instructions |
 * |-----------|----------------------------------|---------------------------|
 * | Anthropic | XML tags, explicitly recommended  | before the documents      |
 * | OpenAI    | Markdown first; XML also fine;    | at BOTH ends; if only one, |
 * |           | JSON measured as poor             | above the context         |
 * | Gemini    | XML or Markdown — pick one and    | context first, instructions |
 * |           | stay consistent                   | at the very end           |
 * | DeepSeek  | no published guidance             | —                         |
 *
 * One Anthropic finding shapes the default: the format of the prompt leaks into
 * the format of the reply — "removing markdown from your prompt can reduce the
 * volume of markdown in the output". So the choice of dialect is not cosmetic;
 * it changes what the model writes back.
 *
 * @module prompt/types
 */

/** How a dialect marks section boundaries. */
export type PromptStyle = 'xml' | 'markdown';

/**
 * A provider's documented prompt preferences.
 *
 * Providers declare this rather than the prompt builder switching on provider
 * id — so adding a vendor means adding a row, not editing every prompt.
 */
export interface PromptDialect {
  /** Section delimiter style. */
  style: PromptStyle;
  /**
   * Repeat sections marked `reprise` at the tail of the request.
   *
   * OpenAI's long-context guidance is to place instructions at both the
   * beginning and the end; Gemini's is to put them at the end outright. An
   * agent conversation is long context by the second turn, so for those
   * dialects the key rules are echoed after the transcript, where they are
   * closest to the model's next decision.
   */
  repeatKeyInstructions: boolean;
  /**
   * Short human-readable note on where this came from, so the next person to
   * touch it can check the source rather than guess at the intent.
   */
  rationale: string;
}

/**
 * One addressable piece of a prompt.
 *
 * `id` is the identity: adding a section whose id already exists **replaces**
 * it. That is what structurally prevents the same instruction appearing twice
 * when several places contribute to one prompt.
 */
export interface PromptSection {
  /** Stable identity. Doubles as the XML tag name, so keep it snake_case. */
  id: string;
  /**
   * Heading text for markdown dialects. Derived from `id` when omitted
   * (`tool_use` becomes "Tool use"), so most sections need not set it.
   */
  title?: string;
  /** The content. Rendered verbatim inside whatever delimiters the dialect uses. */
  body: string;
  /**
   * Sort key. Lower renders earlier; equal values keep insertion order, so
   * callers only need to specify it where the position actually matters.
   */
  order?: number;
  /** Render only for these provider ids. Omitted means every provider. */
  only?: readonly string[];
  /** Never render for these provider ids. Takes precedence over `only`. */
  except?: readonly string[];
  /**
   * Echo this section at the tail of the request on dialects whose vendor
   * recommends repeating instructions in long context. Reserve it for rules
   * that change what the model does next — repeating everything would just
   * double the prompt and dilute the signal it is meant to add.
   */
  reprise?: boolean;
}

/** What a rendered prompt yields: the system text, plus an optional tail echo. */
export interface RenderedPrompt {
  /** Goes in the system prompt / `instructions` field. */
  system: string;
  /**
   * Goes at the tail of the request, after the conversation. Empty unless the
   * dialect asked for a reprise and at least one section opted in.
   */
  reprise: string;
}
