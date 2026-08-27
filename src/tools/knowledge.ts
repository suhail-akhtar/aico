/**
 * Knowledge, as something the agent can consult and add to.
 *
 * Most of the time an entry arrives on its own: matching triggers are attached
 * to the request tail before the model sees the task. This tool is for the
 * other two cases, and both are real.
 *
 * **Looking.** Trigger matching is word overlap, so a task phrased differently
 * from the trigger will not surface an entry that genuinely applies. An agent
 * that suspects there is a convention it has not been told can go and read.
 *
 * **Writing.** The whole value of a knowledge base is that it accumulates, and
 * a base only editable by hand is one that quietly stops being maintained. The
 * moment worth capturing is the one right after being corrected — which is
 * when the agent is here, and the user is not.
 *
 * @module tools/knowledge
 */

import { currentCwd } from '../run-context.js';
import { loadKnowledge, saveKnowledge, deleteKnowledge } from '../knowledge/store.js';
import { matchKnowledge } from '../knowledge/match.js';

export interface KnowledgeInput {
  action?: 'list' | 'search' | 'add' | 'remove';
  /** Search terms, or the id to remove. */
  query?: string;
  /** For `add`: when this guidance applies. */
  trigger?: string;
  /** For `add`: the guidance itself. */
  content?: string;
  /** For `add`: a short identifier. Derived from the trigger when omitted. */
  id?: string;
  /**
   * For `add`: store with the project rather than with the user.
   *
   * Defaults to the project, because most conventions are about a codebase and
   * an entry stored globally follows the reader into repositories where it is
   * wrong — a failure nobody can see from a transcript.
   */
  global?: boolean;
}

export async function knowledgeTool(input: KnowledgeInput): Promise<string> {
  const root = currentCwd();
  const action = input.action ?? 'list';

  if (action === 'add') {
    const trigger = input.trigger?.trim();
    const content = input.content?.trim();
    if (!trigger) {
      return 'add requires a trigger — when this applies. An entry with no trigger '
        + 'is an always-on rule, which belongs in AICO.md instead.';
    }
    if (!content) return 'add requires content.';
    const id = (input.id ?? trigger).toLowerCase().replace(/[^\w]+/g, '-').slice(0, 60);
    const written = await saveKnowledge({
      id,
      trigger,
      content,
      ...input.global ? {} : { projectRoot: root },
    });
    return `Saved knowledge "${id}" to ${written}.\nTrigger: ${trigger}`;
  }

  if (action === 'remove') {
    const id = input.query?.trim();
    if (!id) return 'remove requires the entry id in `query`.';
    const gone = await deleteKnowledge(id, root);
    return gone ? `Removed knowledge "${id}".` : `No knowledge entry called "${id}".`;
  }

  const entries = await loadKnowledge(root);
  if (entries.length === 0) {
    return 'No knowledge entries yet. Add one with action:"add" — a trigger saying '
      + 'when it applies, and the guidance itself.';
  }

  if (action === 'search') {
    const query = input.query?.trim();
    if (!query) return 'search requires terms in `query`.';
    const matches = matchKnowledge(entries, query, root);
    if (matches.length === 0) {
      // Said plainly, because the alternative reading — "there is no convention
      // about this" — is one the agent would act on.
      return `Nothing matched "${query}". Matching is word overlap against each entry's `
        + `trigger, so it can miss; action:"list" shows all ${entries.length}.`;
    }
    return matches
      .map(m => `[${m.entry.id}] (${Math.round(m.score * 100)}% trigger match)\n`
        + `  when: ${m.entry.trigger}\n  ${m.entry.content.replace(/\n/g, '\n  ')}`)
      .join('\n\n');
  }

  return `${entries.length} knowledge entr${entries.length === 1 ? 'y' : 'ies'}:\n`
    + entries
      .map(e => `[${e.id}]${e.scope ? ' (this project)' : ' (global)'}\n  when: ${e.trigger}`)
      .join('\n');
}

export const knowledgeDefinition = {
  name: 'Knowledge',
  description: [
    'Conventions and constraints that apply only sometimes, each with a trigger saying',
    'when. Entries whose trigger matches the current task are attached automatically —',
    'this tool is for when that was not enough.',
    '',
    'actions:',
    '  list   — every entry and its trigger.',
    '  search — entries matching terms. query = the terms.',
    '  add    — record one. trigger = when it applies, content = the guidance.',
    '  remove — delete one. query = its id.',
    '',
    'Use add after being corrected about how this codebase does something — that is the',
    'moment the knowledge exists and the only moment it is cheap to capture. Write a',
    'specific trigger ("when writing database queries in the payments service"), not a',
    'vague one: matching is word overlap, so the words in the trigger are what make it',
    'fire. Guidance that should apply to every task is not knowledge — it belongs in',
    'AICO.md, where it costs less.',
  ].join('\n'),
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'search', 'add', 'remove'],
        description: 'What to do. Defaults to list.',
      },
      query: { type: 'string', description: 'Search terms, or the id to remove.' },
      trigger: { type: 'string', description: 'For add: when this guidance applies.' },
      content: { type: 'string', description: 'For add: the guidance itself.' },
      id: { type: 'string', description: 'For add: a short identifier.' },
      global: {
        type: 'boolean',
        description: 'For add: store with the user rather than the project. Rarely right.',
      },
    },
    required: [] as string[],
  },
};
