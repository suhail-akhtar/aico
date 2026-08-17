/**
 * Rendering a {@link PromptDocument} into one vendor's preferred shape.
 *
 * Pure functions over data: same document plus same dialect always produces the
 * same bytes. That matters more than it sounds — the system prompt is the head
 * of every provider's cache prefix, so a renderer that reordered sections or
 * varied whitespace between calls would silently cost the cache on every turn.
 *
 * @module prompt/render
 */

import { PromptDocument } from './document.js';
import type { PromptDialect, PromptSection, RenderedPrompt, PromptStyle } from './types.js';

/**
 * Render a document for one provider.
 *
 * `system` is the leading block. `reprise` is the tail echo, empty unless the
 * dialect asks for one and some section opted in.
 */
export function renderPrompt(
  doc: PromptDocument,
  dialect: PromptDialect,
  providerId: string,
): RenderedPrompt {
  const sections = doc.forProvider(providerId);
  const system = sections
    .map((section) => renderSection(section, dialect.style))
    .filter(Boolean)
    .join('\n\n');

  if (!dialect.repeatKeyInstructions) return { system, reprise: '' };

  const key = sections.filter((s) => s.reprise);
  if (key.length === 0) return { system, reprise: '' };

  // Labelled so the echo reads as a deliberate restatement rather than as new
  // instructions the model has not seen — an unmarked repeat invites the model
  // to treat it as a second, possibly conflicting, rule set.
  const body = key.map((s) => renderSection(s, dialect.style)).join('\n\n');
  const reprise = dialect.style === 'xml'
    ? `<key_instructions_reminder>\n${body}\n</key_instructions_reminder>`
    : `## Key instructions (reminder)\n\n${body}`;

  return { system, reprise };
}

/**
 * Render the tail block that rides after the conversation.
 *
 * Two things share this position and neither belongs in the cached prefix: the
 * volatile state that changes every turn, and the reprise of key instructions
 * that OpenAI's and Google's long-context guidance asks for. They are wrapped
 * together in one operator-state marker so the model reads them as supplied by
 * the harness rather than typed by the user — the portable stand-in for a
 * mid-conversation system turn, which most providers do not offer.
 *
 * The marker follows the dialect for the same reason everything else does:
 * Google asks that one structural style be used consistently within a prompt,
 * and an XML tag dropped into an otherwise-Markdown prompt is exactly the
 * inconsistency that warning is about.
 */
export function renderTail(
  volatile: PromptDocument,
  reprise: string,
  dialect: PromptDialect,
  providerId: string,
): string {
  const parts = volatile
    .forProvider(providerId)
    .map((section) => renderSection(section, dialect.style))
    .filter(Boolean);
  if (reprise) parts.push(reprise);
  if (parts.length === 0) return '';

  const body = parts.join('\n\n');
  return dialect.style === 'xml'
    ? `<system_reminder>\n${body}\n</system_reminder>`
    : `# System reminder\n\n${body}`;
}

/** Render one section in the given style. Empty bodies render to nothing. */
export function renderSection(section: PromptSection, style: PromptStyle): string {
  const body = section.body.trim();
  if (!body) return '';
  return style === 'xml'
    ? `<${section.id}>\n${body}\n</${section.id}>`
    : `## ${section.title ?? titleFromId(section.id)}\n\n${body}`;
}

/**
 * Derive a heading from an id: `tool_use` becomes "Tool use".
 *
 * Saves every section declaring a `title` that merely restates its `id`, which
 * is the kind of duplication that goes stale the moment one of the two is
 * edited.
 */
export function titleFromId(id: string): string {
  const words = id.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
