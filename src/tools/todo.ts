import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import os from 'os';

const TODO_FILE = '.aico-todos.json';

export interface Todo {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'done' | 'cancelled';
  priority: 'high' | 'medium' | 'low';
}

function todoFilePath(): string {
  return path.join(os.homedir(), TODO_FILE);
}

async function loadTodos(): Promise<Todo[]> {
  try {
    const raw = await readFile(todoFilePath(), 'utf8');
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
  await writeFile(todoFilePath(), JSON.stringify(input.todos, null, 2), 'utf8');
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
