/**
 * Per-provider prompt dialects, each traceable to that vendor's own guidance.
 *
 * This table is the only place provider identity influences prompt shape.
 * Adding a vendor is a row here plus a `promptDialect` on its provider class —
 * no prompt content changes, and nothing else in the codebase branches on
 * provider id to decide formatting.
 *
 * @module prompt/dialects
 */

import type { PromptDialect } from './types.js';

/**
 * Anthropic: XML, no reprise.
 *
 * XML tags are recommended outright — wrap each kind of content in its own tag
 * so the model can tell instructions from context from examples. The reprise is
 * off because the same guidance puts instructions *before* long documents
 * rather than after, and because Anthropic's prompt caching makes a stable
 * leading block the cheap position.
 *
 * The choice also changes the reply, not just the request: per Anthropic,
 * "removing markdown from your prompt can reduce the volume of markdown in the
 * output" — so an XML prompt is also how you stop getting bulleted answers to
 * everything.
 */
export const ANTHROPIC_DIALECT: PromptDialect = {
  style: 'xml',
  repeatKeyInstructions: false,
  rationale: 'Anthropic documents XML tags for prompt structure; prompt format '
    + 'also influences reply format, so XML reduces markdown in responses.',
};

/**
 * OpenAI: XML, no reprise.
 *
 * This row used to say Markdown with a tail reprise, on the GPT-4.1 guide's
 * advice. Both halves of that have since been superseded, and a dialect table
 * whose citations have expired is worse than none — it looks researched.
 *
 * **Structure.** The GPT-5.x guides are themselves written in structured XML
 * specs — `<output_verbosity_spec>`, `<tool_usage_rules>`,
 * `<long_context_handling>` — and say so explicitly: specs of that shape
 * "improved instruction adherence" and let one section reference another by
 * name elsewhere in the prompt. Markdown is now scoped to where it is
 * *semantically* correct — code fences, lists, tables — rather than being the
 * skeleton. A section id is a name, not a heading, so it belongs in a tag.
 *
 * **No reprise.** The bookend rule is gone. Where GPT-4.1 asked for
 * instructions at both ends of long context, GPT-5.x asks for summarization and
 * re-grounding *during* the task — active recall rather than passive repetition
 * at the boundaries. Nothing in the tail-echo mechanism implements that, so
 * emitting one now just spends tokens restating what the head already said.
 *
 * @see https://developers.openai.com/cookbook/examples/gpt-5/gpt-5-2_prompting_guide
 */
export const OPENAI_DIALECT: PromptDialect = {
  style: 'xml',
  repeatKeyInstructions: false,
  rationale: 'The GPT-5.x prompting guides are written in structured XML specs and '
    + 'credit them with better instruction adherence; the GPT-4.1 bookend rule was '
    + 'replaced by mid-task re-grounding, which a tail echo does not implement.',
};

/**
 * Gemini: Markdown, with a tail reprise.
 *
 * Google calls XML tags and Markdown headings equally effective and asks only
 * that one be chosen and used consistently. Markdown is picked to match the
 * OpenAI-compatible path this provider already runs on, keeping one fewer thing
 * different between them.
 *
 * The reprise is the stronger recommendation here than for OpenAI: with large
 * context Google says to supply the context first and place instructions "at
 * the very end".
 */
export const GEMINI_DIALECT: PromptDialect = {
  style: 'markdown',
  repeatKeyInstructions: true,
  rationale: 'Google treats XML and Markdown as equally effective but insists on '
    + 'consistency; with long context it places instructions at the very end.',
};

/**
 * DeepSeek: Markdown, no reprise — and deliberately *not* XML.
 *
 * DeepSeek publishes no prose-structure guidance; the API docs show a bare
 * "You are a helpful assistant" and nothing about sections at all. So this row
 * is argued from the one authoritative structural artifact that does exist: the
 * V4 encoding format, and specifically what DeepSeek itself puts into the
 * system message.
 *
 * **Markdown, because DeepSeek writes Markdown into this very message.** When
 * tools are present the runtime injects its own tool block into the system
 * message, and that block opens with a Markdown heading — `## Tools`, followed
 * by prose. A prompt whose harness-authored half is `## Tools` and whose
 * product-authored half is `<tool_use>` is a prompt in two structural styles,
 * which is the one thing every vendor with an opinion warns against.
 *
 * **Not XML, because on V4 tags are protocol rather than prose.** The model
 * speaks a tag language of its own: `<think>` delimits reasoning, and tool calls
 * are DSML — `<｜DSML｜invoke name="...">`, `<｜DSML｜parameter string="true">`.
 * Those tags *mean* something to the decoder. Wrapping our sections in ordinary
 * XML places invented tags directly beside load-bearing ones and invites the
 * model to read `<tool_use>` as a malformed instruction to call a tool rather
 * than as a heading. The risk is small and entirely avoidable, and the upside
 * over a Markdown heading is unmeasured.
 *
 * This lands on the same two values the default carries. That is the finding,
 * not an oversight: what changes is that DeepSeek now has a row with a reason,
 * so the next person to touch it argues with the evidence rather than assuming
 * nobody looked.
 *
 * @see https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash/blob/main/encoding/README.md
 */
export const DEEPSEEK_DIALECT: PromptDialect = {
  style: 'markdown',
  repeatKeyInstructions: false,
  rationale: 'DeepSeek injects its own tool block into the system message under a '
    + 'Markdown heading, so Markdown keeps the prompt in one style; V4 reserves tag '
    + 'markup for protocol (<think>, DSML), which our own tags should not sit beside.',
};

/**
 * Default for vendors with no published prompt-structure guidance.
 *
 * Z.AI and Ollama models publish nothing specific, so this picks the
 * option with the broadest evidence rather than inventing a preference:
 * Markdown is recommended by OpenAI, accepted by Google, and is what most
 * instruction-tuned models saw most of in training. The reprise stays off
 * because no source recommends it for these models and it costs tokens.
 *
 * If one of these vendors publishes guidance, give it its own row rather than
 * changing this default — the point of a named default is that it is the
 * considered fallback, not a place to accumulate special cases.
 */
export const DEFAULT_DIALECT: PromptDialect = {
  style: 'markdown',
  repeatKeyInstructions: false,
  rationale: 'No vendor guidance published; Markdown is the broadest-support '
    + 'default and no source recommends a reprise for these models.',
};
