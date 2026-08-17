/**
 * Provider-adaptive prompt construction.
 *
 * Write the prompt once as a {@link PromptDocument}; each provider declares a
 * {@link PromptDialect}; {@link renderPrompt} produces the shape that vendor
 * documents as best.
 *
 * ```ts
 * const doc = new PromptDocument()
 *   .add({ id: 'role', body: 'You are aico…' })
 *   .add({ id: 'behaviour', body: '…', reprise: true })
 *   .add({ id: 'xml_output', body: '…', only: ['anthropic'] });
 *
 * const { system, reprise } = renderPrompt(doc, provider.promptDialect, provider.id);
 * ```
 *
 * @module prompt
 */

export type {
  PromptDialect,
  PromptSection,
  PromptStyle,
  RenderedPrompt,
} from './types.js';
export { PromptDocument } from './document.js';
export { renderPrompt, renderTail, renderSection, titleFromId } from './render.js';
export {
  ANTHROPIC_DIALECT,
  OPENAI_DIALECT,
  GEMINI_DIALECT,
  DEFAULT_DIALECT,
} from './dialects.js';
