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
 * OpenAI: Markdown, with a tail reprise.
 *
 * The GPT-4.1 guide names Markdown as the starting point — title hierarchy for
 * sections, backticks for code — while noting XML also performs well and JSON
 * measurably poorly. Markdown is taken as the default precisely because it is
 * the documented one; XML's advantages there are for wrapping documents, which
 * is not what a system prompt is.
 *
 * The reprise implements the long-context rule verbatim: "place your
 * instructions at both the beginning and end of the provided context".
 */
export const OPENAI_DIALECT: PromptDialect = {
  style: 'markdown',
  repeatKeyInstructions: true,
  rationale: 'OpenAI GPT-4.1 guide recommends Markdown headers, and instructions '
    + 'at both the beginning and end of long context.',
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
 * Default for vendors with no published prompt-structure guidance.
 *
 * DeepSeek, Z.AI and Ollama models publish nothing specific, so this picks the
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
