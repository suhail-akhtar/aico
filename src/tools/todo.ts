/**
 * The task list, and whose it is.
 *
 * It used to be one file in the home directory, shared by every session on the
 * machine. Open a new chat and it inherited whatever the last one had left
 * unfinished — observed live: a fresh session about a counter button opened
 * holding five items from an unrelated floor-plan project, and the completion
 * gate dutifully refused to let it finish until the model worked out they were
 * somebody else's and cancelled them.
 *
 * A task list belongs to the piece of work that created it. Keyed by session,
 * so the gate is asking about this turn's work and the panel is showing it.
 *
 * @module tools/todo
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { currentRunContext } from '../run-context.js';

const TODO_DIR = path.join(os.homedir(), '.aico', 'todos');
/** Where a run with no session id lands — a one-shot CLI invocation. */
const UNSCOPED = 'unscoped';

export interface Todo {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'done' | 'cancelled';
  priority: 'high' | 'medium' | 'low';
}

/**
 * A session id reduced to something safe to use as a filename.
 *
 * The readable part is truncated and has its punctuation folded, so two ids
 * could reduce to the same name and one session would read another's list —
 * the exact fault this file was keyed by session to fix. A short hash of the
 * *whole* id is appended so only genuinely identical sessions collide.
 */
function todoFilePath(sessionId?: string): string {
  const id = sessionId ?? currentRunContext()?.sessionId ?? UNSCOPED;
  const readable = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  const digest = createHash('sha256').update(id).digest('hex').slice(0, 10);
  return path.join(TODO_DIR, `${readable}-${digest}.json`);
}

async function loadTodos(sessionId?: string): Promise<Todo[]> {
  try {
    const raw = await readFile(todoFilePath(sessionId), 'utf8');
    return JSON.parse(raw) as Todo[];
  } catch {
    return [];
  }
}

function formatTodos(todos: Todo[]): string {
  if (todos.length === 0) return 'No todos found.';
  const lines = todos.map((t) => {
    const status = t.status.padEnd(11);
    const priority = t.priority.padEnd(6);
    return `[${t.id}] [${status}] [${priority}] ${t.title}`;
  });
  return lines.join('\n');
}

export async function todoRead(): Promise<string> {
  const todos = await loadTodos();
  return formatTodos(todos);
}

/**
 * Count incomplete todos (pending or in_progress). Used by the agent loop's
 * completion gate to decide whether to nudge the model to continue instead of
 * stopping when it emits a text-only turn. Returns 0 on any read error so the
 * gate never blocks on a missing/corrupt todo file.
 */
export async function getOpenTodoCount(): Promise<number> {
  const todos = await loadTodos();
  return todos.filter(t => t.status === 'pending' || t.status === 'in_progress').length;
}

export interface TodoWriteInput {
  todos: Todo[];
}

export async function todoWrite(input: TodoWriteInput): Promise<string> {
  const file = todoFilePath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(input.todos, null, 2), 'utf8');
  return `Saved ${input.todos.length} todo(s).\n${formatTodos(input.todos)}`;
}

export const todoReadDefinition = {
  name: 'TodoRead',
  description: 'Read the current todo list from .aico-todos.json in the user home directory.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const todoWriteDefinition = {
  name: 'TodoWrite',
  description: 'Write (replace) the todo list in .aico-todos.json.',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'Array of todo items.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'done', 'cancelled'],
            },
            priority: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
            },
          },
          required: ['id', 'title', 'status', 'priority'],
        },
      },
    },
    required: ['todos'],
  },
};

/**
 * Close out the list because the reader said so, not because the work happened.
 *
 * The message that carries this intent also reaches the model, and on its own
 * that would be enough — if the model always complied. It does not have to.
 * The completion gate reads *this file*, so a list left open here goes on
 * nudging the model back to work the reader just called off, and the reader
 * watches their own instruction being argued with.
 *
 * So the file is settled here, in the loop, and the message is what makes the
 * model understand why. Neither half is sufficient: settle without telling and
 * the model works from a list it still believes in; tell without settling and
 * the gate overrules the telling.
 *
 * Only open items are touched. What was genuinely finished stays finished, and
 * what was already cancelled is not resurrected as `done` — the record of what
 * happened is not the reader's to rewrite.
 */
export async function retireTodos(
  outcome: 'done' | 'cancelled',
  sessionId?: string,
): Promise<number> {
  const todos = await loadTodos(sessionId);
  const open = todos.filter(t => t.status === 'pending' || t.status === 'in_progress');
  if (open.length === 0) return 0;

  const settled = todos.map(t => (
    t.status === 'pending' || t.status === 'in_progress' ? { ...t, status: outcome } : t
  ));
  const file = todoFilePath(sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(settled, null, 2), 'utf8');
  return open.length;
}
