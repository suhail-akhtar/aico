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
 * | Vendor    | Structure                          | Instructions in long context |
 * |-----------|------------------------------------|------------------------------|
 * | Anthropic | XML tags, explicitly recommended    | before the documents         |
 * | OpenAI    | structured XML specs, credited with | re-ground mid-task; the       |
 * |           | better instruction adherence        | bookend rule was retired     |
 * | Gemini    | XML or Markdown — pick one and      | context first, instructions  |
 * |           | stay consistent                     | at the very end              |
 * | DeepSeek  | none published; its own injected    | —                            |
 * |           | tool block is a Markdown heading    |                              |
 *
 * They also disagree *over time*, which is the harder problem. OpenAI's row
 * above is the second one it has had: Markdown-first with a tail reprise, on
 * the GPT-4.1 guide, until the GPT-5.x guides replaced both halves. Every row
 * therefore carries a `rationale` naming its source, so the next reader can
 * check whether it still holds rather than inheriting it as fact.
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
   * Gemini's long-context guidance is to put instructions at the very end, and
   * an agent conversation is long context by the second turn — so its key rules
   * are echoed after the transcript, closest to the model's next decision.
   *
   * Only Gemini asks for this now. OpenAI did, under the GPT-4.1 bookend rule;
   * GPT-5.x asks instead for summarization and re-grounding *during* the task,
   * which is a different mechanism and not one a tail echo implements. The flag
   * stays because one vendor still wants it, not because it is generally good.
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
   * Render only under these dialect styles. Omitted means every style.
   *
   * The distinction from `only` matters more than it looks. Some sections are
   * about a *vendor* — a quirk of one API. Others are about the *shape of the
   * prompt they sit in*, and those must key on the shape, because the set of
   * vendors using a given shape changes: instructions about restraining
   * markdown in the reply make sense inside an XML prompt and contradict a
   * Markdown one, whoever is serving it.
   *
   * Keying those to a provider id was a latent bug rather than a style
   * preference. It silently excluded a Claude model routed through OpenRouter —
   * XML dialect, provider id `openrouter` — from a section written for exactly
   * that prompt.
   */
  styles?: readonly PromptStyle[];
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
