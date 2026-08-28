/**
 * The contract for a rendered block, fetched rather than injected.
 *
 * ## Why this is a tool and not more prompt
 *
 * The system prompt is prefix, and prefix is what prompt caching bills on every
 * request of every session. A worked example per drawable kind is affordable at
 * three kinds and ruinous at fifteen — several hundred lines charged on every
 * turn, for a capability most turns never use.
 *
 * So the prompt carries one line per kind, which is enough to *decide* to draw
 * something, and the shape needed to actually draw it is one call away. A
 * session that never visualises anything pays for the catalog and nothing else.
 *
 * ## Why it is not left to the model's memory
 *
 * The failure this exists to prevent is documented in `shared/widgets/catalog`:
 * a console that published each widget's name and description and nothing about
 * its options, leaving invention as the only strategy. It produced confident,
 * well-formed, wrong specs — an array of objects where the renderer wanted
 * arrays of arrays. That is a platform bug. The contract was known; it simply
 * was not published anywhere the author could reach.
 *
 * @module tools/widget-spec
 */

import { WIDGET_CATALOG, widgetById, widgetForLanguage } from '../../shared/widgets/catalog.js';

export interface WidgetSpecInput {
  /** The kind to describe. A fence language works too. */
  kind?: string;
}

export function getWidgetSpec(input: WidgetSpecInput): string {
  const wanted = (input.kind ?? '').trim();

  // No argument is a reasonable question — "what can I draw?" — and answering
  // it with an error would be pedantry. The list is short.
  if (!wanted) {
    return ['Rendered block kinds. Ask for one by name for its full shape.', '']
      .concat(WIDGET_CATALOG.map(kind => `${kind.id} (\`\`\`${kind.languages.join(', ')}) — ${kind.summary}`))
      .join('\n');
  }

  // By id or by any fence language it answers to, because the caller is as
  // likely to be holding the word it was about to write as the canonical name.
  const kind = widgetById(wanted.toLowerCase()) ?? widgetForLanguage(wanted);
  if (!kind) {
    return `No rendered block named "${wanted}". Available: `
      + `${WIDGET_CATALOG.map(k => k.id).join(', ')}.`;
  }

  return [
    `\`\`\`${kind.languages[0]} — ${kind.summary}`,
    kind.languages.length > 1
      ? `Also accepts: ${kind.languages.slice(1).map(l => `\`\`\`${l}`).join(', ')}`
      : '',
    '',
    kind.spec,
  ].filter(Boolean).join('\n');
}

export const widgetSpecDefinition = {
  name: 'WidgetSpec',
  description:
    'The exact shape of a fenced block that draws in the chat — chart, table, '
    + 'diagram and the rest. Call this before writing one whose format you are '
    + 'not certain of, rather than guessing: a well-formed guess that does not '
    + 'match the renderer fails as a wall of raw JSON. Omit `kind` to list them.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        description: 'Block kind or fence language, e.g. "chart" or "mermaid". '
          + 'Omit to list every kind with a one-line summary.',
      },
    },
    required: [],
  },
};
