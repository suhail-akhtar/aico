/**
 * Remembering, and — the part that was missing — forgetting.
 *
 * The fourth registry, same shape as the other three. The verb names differ
 * because the domain has better words for them: `remember` rather than create,
 * `forget` rather than delete. Everything else is the pattern.
 *
 * **Scope is asked for explicitly, and defaults to the project.** "Remember
 * this" is ambiguous in a way that matters: a global memory that should have
 * been project-scoped follows someone into every repository they open, and a
 * session memory saved globally does the same with a detail that was true for
 * ten minutes. The project is the right default because it is the middle
 * option — wrong in the least costly direction either way.
 *
 * @module tools/manage-memory
 */

import { currentCwd, currentRunContext } from '../run-context.js';
import fs from 'fs';
import path from 'path';
import {
  applicable, listScope, remember, findMemory, updateMemory, forgetMemory,
  searchMemories, memoryRoot, setMemoryEnabled, type MemoryScope, type StoredMemory,
} from '../memory/store.js';

export interface MemoryManageInput {
  action: 'list' | 'remember' | 'update' | 'forget' | 'search' | 'enable' | 'disable' | 'export' | 'import';
  /** For export/import: the JSON file. */
  path?: string;
  /** What to remember, or the new text when updating. */
  text?: string;
  id?: string;
  scope?: MemoryScope | 'all';
  tags?: string[];
  query?: string;
  /** Override which project or session this belongs to. */
  belongsTo?: string;
}

function line(memory: StoredMemory): string {
  const off = memory.enabled ? '' : ' [disabled]';
  const tags = memory.tags.length ? ` [${memory.tags.join(', ')}]` : '';
  const first = memory.text.split('\n')[0]!;
  const text = first.length > 160 ? `${first.slice(0, 157)}…` : first;
  return `- ${memory.id} (${memory.scope})${off}${tags}: ${text}`;
}

export async function executeMemoryManage(input: MemoryManageInput): Promise<string> {
  const cwd = currentCwd();
  const sessionId = currentRunContext()?.sessionId;

  switch (input.action) {
    case 'list': {
      const scope = input.scope ?? 'all';
      const found = scope === 'all'
        ? applicable(cwd, sessionId)
        : listScope(scope, scope === 'project' ? (input.belongsTo ?? cwd) : (input.belongsTo ?? sessionId));

      if (found.length === 0) {
        return scope === 'all'
          ? `Nothing remembered yet for this project. Memories live in ${memoryRoot()}.`
          : `Nothing remembered at ${scope} scope.`;
      }
      return [
        `${found.length} memor${found.length === 1 ? 'y' : 'ies'}${scope === 'all' ? ' that apply here' : ` at ${scope} scope`}:`,
        ...found.map(line),
      ].join('\n');
    }

    case 'remember': {
      if (!input.text?.trim()) return 'Nothing to remember — text is required.';
      // Project rather than global: see the note at the top. A wrong guess here
      // is the difference between a useful memory and one that follows someone
      // into every repository they open.
      const scope: MemoryScope = (input.scope === 'all' ? 'project' : input.scope) ?? 'project';
      if (scope === 'session' && !sessionId && !input.belongsTo) {
        return 'There is no session to attach this to. Use scope:"project" or scope:"global".';
      }
      const stored = remember(input.text, scope, {
        belongsTo: input.belongsTo ?? (scope === 'project' ? cwd : scope === 'session' ? sessionId : undefined),
        tags: input.tags,
      });
      const where = scope === 'global' ? 'everywhere'
        : scope === 'project' ? `this project (${cwd})`
          : 'this conversation only';
      return `Remembered as "${stored.id}", applying to ${where}.\nForget it with action:"forget" id:"${stored.id}".`;
    }

    case 'update': {
      if (!input.id) return 'An id is required. Use action:"list" to see them.';
      if (!input.text?.trim() && !input.tags) return 'Give new text, or new tags.';
      const found = findMemory(input.id, cwd, sessionId);
      if (!found) return `No memory called "${input.id}" applies here.`;
      const updated = updateMemory(found, input.text ?? found.text, input.tags);
      return `Updated "${updated.id}".`;
    }

    case 'forget': {
      if (!input.id) return 'An id is required. Use action:"list" to see them.';
      const found = findMemory(input.id, cwd, sessionId);
      if (!found) return `No memory called "${input.id}" applies here.`;
      forgetMemory(found);
      return `Forgot "${found.id}". It is gone from disk.`;
    }

    case 'search': {
      const query = input.query ?? input.text ?? '';
      if (!query.trim()) return 'A query is required.';
      const hits = searchMemories(query, cwd, sessionId);
      return hits.length === 0
        ? `Nothing remembered matches "${query}".`
        : [`${hits.length} match(es) for "${query}":`, ...hits.map(line)].join('\n');
    }

    case 'enable':
    case 'disable': {
      if (!input.id) return 'An id is required. Use action:"list" to see them.';
      const found = findMemory(input.id, cwd, sessionId);
      if (!found) return `No memory called "${input.id}" applies here.`;
      const wanted = input.action === 'enable';
      const changed = setMemoryEnabled(found, wanted);
      return changed
        ? `"${found.id}" is now ${wanted ? 'active again' : 'silenced'}.`
          + (wanted ? '' : ' It stays on disk; the agent just stops being told it.')
        : `"${found.id}" was already ${wanted ? 'active' : 'silenced'}.`;
    }

    case 'export': {
      if (!input.path) return 'A path is required — where to write the JSON.';
      const scope = input.scope ?? 'all';
      const chosen = scope === 'all' ? applicable(cwd, sessionId) : listScope(scope, input.belongsTo);
      const target = path.resolve(input.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // Scope and belongsTo are dropped: they describe where these lived on
      // this machine, and importing decides that afresh. Carrying them would
      // reinstate a project path that means nothing on the other end.
      fs.writeFileSync(target, JSON.stringify({
        memories: chosen.map(m => ({ text: m.text, tags: m.tags })),
      }, null, 2), 'utf8');
      return `Exported ${chosen.length} memor${chosen.length === 1 ? 'y' : 'ies'} to ${target}.`;
    }

    case 'import': {
      if (!input.path) return 'A path is required — the JSON file to read.';
      const target = path.resolve(input.path);
      if (!fs.existsSync(target)) return `${target} does not exist.`;
      let parsed: { memories?: Array<{ text?: string; tags?: string[] }> };
      try { parsed = JSON.parse(fs.readFileSync(target, 'utf8')); }
      catch (err) { return `${target} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`; }

      const incoming = (parsed.memories ?? []).filter(m => m.text?.trim());
      if (incoming.length === 0) return 'That file holds no memories.';
      const scope: MemoryScope = (input.scope === 'all' ? 'project' : input.scope) ?? 'project';
      const existing = new Set(listScope(scope, input.belongsTo ?? cwd).map(m => m.text.trim().toLowerCase()));

      let added = 0, skipped = 0;
      for (const entry of incoming) {
        // Importing the same file twice should not double every memory.
        if (existing.has(entry.text!.trim().toLowerCase())) { skipped++; continue; }
        remember(entry.text!, scope, {
          belongsTo: input.belongsTo ?? (scope === 'project' ? cwd : scope === 'session' ? sessionId : undefined),
          tags: entry.tags,
        });
        added++;
      }
      return `Imported ${added} memor${added === 1 ? 'y' : 'ies'} at ${scope} scope`
        + (skipped ? `, skipping ${skipped} already remembered.` : '.');
    }

    default:
      return `Unknown action "${String(input.action)}".`;
  }
}

export const memoryManageToolDefinition = {
  name: 'MemoryManage',
  description: [
    'Remember things across turns, and forget them: list, remember, update, forget, search.',
    'Use this when someone says to remember or forget something, asks what you remember, or tells you',
    'a durable fact about how they work or how this project works.',
    'Scope it: "global" applies everywhere, "project" only in this directory, "session" only in this',
    'conversation. Default is project.',
  ].join(' '),
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'remember', 'update', 'forget', 'search', 'enable', 'disable', 'export', 'import'],
        description:
          'list: everything that applies here, or one scope. remember: store something new. '
          + 'update: change one. forget: delete one for good. search: find by words. '
          + 'enable/disable: silence one without deleting it, for a fact that is true again later. '
          + 'export/import: JSON files.',
      },
      text: { type: 'string', description: 'What to remember, or the replacement text when updating.' },
      id: { type: 'string', description: 'Which memory, for update and forget. Shown by list.' },
      scope: {
        type: 'string',
        enum: ['global', 'project', 'session', 'all'],
        description:
          'global: true everywhere, e.g. a preference. project: true in this directory only. '
          + 'session: true for this conversation only. all: for listing. Default when remembering is project.',
      },
      tags: { type: 'array', items: { type: 'string' }, description: 'Labels to find it by later.' },
      query: { type: 'string', description: 'Words to search for.' },
      belongsTo: { type: 'string', description: 'A different project path or session id than the current one.' },
      path: { type: 'string', description: 'For export: where to write. For import: the file to read.' },
    },
    required: ['action'],
  },
};
