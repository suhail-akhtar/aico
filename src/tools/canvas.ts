/**
 * `Canvas` — write a document or a code file the person edits beside the chat.
 *
 * The content lives in the session's canvas store, versioned; the reply
 * carries only a ```canvas reference card. So the transcript stays small, the
 * document is the one place its text is, and an edit the person makes in the
 * editor is what the agent reads next — not a stale copy from three turns ago.
 *
 * `update` and `edit` name the version they were based on. If the person (or
 * anything else) changed the canvas since, the write is refused and the
 * result carries the latest content to re-apply the change to. That is
 * enforced here rather than asked for in the prompt: a model that remembers
 * the text is exactly the model that stops re-reading it.
 *
 * @module tools/canvas
 */

import { currentRunContext } from '../run-context.js';
import { getWorkspaceRuntime } from '../workspace.js';
import {
  applyFindReplace, createCanvas, getCanvas, listCanvases, writeCanvas,
  type CanvasContext, type CanvasDoc,
} from '../canvas/store.js';

export interface CanvasInput {
  action?: 'create' | 'read' | 'update' | 'edit' | 'list';
  id?: string;
  title?: string;
  kind?: 'document' | 'code';
  language?: string;
  content?: string;
  version?: number;
  find?: string;
  replace?: string;
  all?: boolean;
  note?: string;
}

function context(): CanvasContext {
  const runtime = getWorkspaceRuntime();
  const sessionId = currentRunContext()?.sessionId ?? runtime.sessionId;
  if (!sessionId) throw new Error('Canvas needs a chat session to keep the document in.');
  return { settings: runtime.settings, cwd: runtime.cwd ?? process.cwd(), sessionId };
}

function ref(doc: CanvasDoc): string {
  const card = { id: doc.id, title: doc.title, kind: doc.kind, ...(doc.language ? { language: doc.language } : {}) };
  return `\`\`\`canvas\n${JSON.stringify(card)}\n\`\`\``;
}

function describe(doc: CanvasDoc): string {
  const last = doc.versions[doc.versions.length - 1];
  const by = last?.author === 'user' ? 'the user' : 'you (the agent)';
  const what = doc.kind === 'code' ? `code${doc.language ? `, ${doc.language}` : ''}` : 'document';
  return `Canvas ${doc.id} "${doc.title}" (${what}) — version ${doc.version}, last edited by ${by}.`;
}

function body(doc: CanvasDoc): string {
  return `----- canvas content (version ${doc.version}) -----\n${doc.content}\n----- end of canvas -----`;
}

function card(doc: CanvasDoc): string {
  return 'Put this block in your reply so the user can open the canvas. It is only a reference card — '
    + 'do not paste the content into the chat, and do not describe every change line by line:\n'
    + ref(doc);
}

function stale(doc: CanvasDoc, base: number | undefined): Error {
  const who = doc.versions[doc.versions.length - 1]?.author === 'user' ? 'The user edited it' : 'It changed';
  return new Error(
    `NOT APPLIED — canvas ${doc.id} is at version ${doc.version}, not ${base ?? '(no version given)'}. `
    + `${who} since your last read. Re-apply your change to this latest content and pass version: ${doc.version}.\n`
    + `${describe(doc)}\n${body(doc)}`,
  );
}

async function load(ctx: CanvasContext, id: string | undefined): Promise<CanvasDoc> {
  if (!id) throw new Error('`id` is required — `list` shows the canvases in this chat.');
  const doc = await getCanvas(ctx, id);
  if (!doc) {
    const known = await listCanvases(ctx);
    throw new Error(`No canvas "${id}" in this chat.${known.length
      ? ` Canvases here: ${known.map(c => `${c.id} "${c.title}"`).join(', ')}.`
      : ' There are none yet — use create.'}`);
  }
  return doc;
}

export async function canvasTool(input: CanvasInput): Promise<string> {
  const ctx = context();
  const action = input.action ?? (input.id ? 'read' : 'list');

  switch (action) {
    case 'list': {
      const all = await listCanvases(ctx);
      if (all.length === 0) return 'No canvases in this chat yet.';
      return ['Canvases in this chat (newest first):', ...all.map(c =>
        `- ${c.id} "${c.title}" — ${c.kind}${c.language ? ` (${c.language})` : ''}, version ${c.version}, `
        + `last edited by ${c.author === 'user' ? 'the user' : 'the agent'}, ${c.chars.toLocaleString()} characters`)].join('\n');
    }

    case 'read': {
      const doc = await load(ctx, input.id);
      return `${describe(doc)}\nPass version: ${doc.version} when you update or edit it.\n${body(doc)}`;
    }

    case 'create': {
      if (typeof input.content !== 'string') throw new Error('`content` is required to create a canvas (Markdown for a document, source for code).');
      if (!input.title?.trim()) throw new Error('`title` is required to create a canvas.');
      const doc = await createCanvas(ctx, {
        title: input.title, kind: input.kind ?? 'document', content: input.content, author: 'agent',
        ...(input.language ? { language: input.language } : {}),
      });
      return `Created canvas ${doc.id} "${doc.title}" (${doc.kind}), version 1. The user can now edit it directly.\n${card(doc)}`;
    }

    case 'update':
    case 'edit': {
      const doc = await load(ctx, input.id);
      if (typeof input.version !== 'number' || input.version !== doc.version) throw stale(doc, input.version);
      let content: string;
      if (action === 'update') {
        if (typeof input.content !== 'string') throw new Error('`content` is required for update (the whole new text). For a targeted change use edit with find/replace.');
        content = input.content;
      } else {
        const r = applyFindReplace(doc.content, input.find ?? '', input.replace ?? '', input.all === true);
        if (!r.ok) throw new Error(`NOT APPLIED — ${r.error}`);
        content = r.content;
      }
      const written = await writeCanvas(ctx, doc.id, {
        content, baseVersion: doc.version, author: 'agent',
        ...(input.note ? { note: input.note } : {}),
        ...(input.title?.trim() ? { title: input.title } : {}),
      });
      if (!written.ok) throw stale(written.canvas, input.version);
      if (!written.changed) return `Canvas ${doc.id} already has that content — still version ${doc.version}.`;
      return `Canvas ${doc.id} "${written.canvas.title}" is now version ${written.canvas.version}.\n${card(written.canvas)}`;
    }

    default:
      throw new Error(`Unknown action "${String(action)}". Use create, read, update, edit or list.`);
  }
}

export const canvasDefinition = {
  name: 'Canvas',
  description:
    'A document or code file that you write and the user edits directly, side by side with the chat. '
    + 'Use it for anything the user will iterate on — essays, emails, reports, specs, a code file — instead of '
    + 'pasting long text into the chat. Actions:\n'
    + '- create {title, kind: "document"|"code", language?, content} — content is Markdown for a document, source code for code.\n'
    + '- read {id} — the latest content and its version. The user edits canvases directly, so ALWAYS read before '
    + 'changing one they may have touched.\n'
    + '- edit {id, version, find, replace, all?} — replace one exact passage (like Edit): `find` must occur exactly once '
    + 'unless all: true. Prefer this for targeted changes.\n'
    + '- update {id, version, content} — replace the whole text (rewrites, big restructures).\n'
    + '- list — the canvases in this chat.\n'
    + '`version` is the version your last read/create/update returned. If the canvas changed since, the write is refused '
    + 'and the result carries the latest content — re-apply your change to it. After create/update/edit, put the '
    + '```canvas block from the result in your reply: it is only a reference card that opens the canvas, never repeat '
    + 'the content in the chat. A message like "Edit canvas <id> — …" means: read that canvas, then edit it.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'read', 'update', 'edit', 'list'] },
      id: { type: 'string', description: 'The canvas id (from create or list).' },
      title: { type: 'string', description: 'create: the title. update/edit: optionally rename.' },
      kind: { type: 'string', enum: ['document', 'code'], description: 'create: document (Markdown) or code.' },
      language: { type: 'string', description: 'create, kind code: the language, e.g. "typescript", "python".' },
      content: { type: 'string', description: 'create/update: the full text.' },
      version: { type: 'number', description: 'update/edit: the version you last read or wrote.' },
      find: { type: 'string', description: 'edit: the exact passage to replace.' },
      replace: { type: 'string', description: 'edit: what replaces it.' },
      all: { type: 'boolean', description: 'edit: replace every occurrence of find.' },
      note: { type: 'string', description: 'update/edit: a few words on what changed, shown in the version history.' },
    },
    required: ['action'],
  },
};
