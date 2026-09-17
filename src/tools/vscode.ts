/**
 * The six tools an editor lends the agent.
 *
 * Each is a thin shell: validate the arguments, hand the call to whatever is
 * driving this run, return what came back. There is no VS Code code in here and
 * there must not be — the engine runs in a terminal, a cron job and an MCP
 * server too, and importing `vscode` would break all three at load time. What
 * lives here is the *contract*; the implementation lives in the extension, on
 * the other side of the round trip described in `shared/host-tools`.
 *
 * ## Diagnostics is the one that changes how the agent works
 *
 * The others are conveniences. This one closes a loop the agent has never
 * had: after an edit it can ask the language server what it thinks, rather than
 * grepping for the shape of an error message or running a build to find out.
 * It is the difference between "I changed the type" and "I changed the type and
 * nothing downstream broke".
 *
 * It is also why the diagnostics call takes a `settleMs`. A language server
 * reports asynchronously, and reading Problems the instant after a write
 * reliably returns the *previous* state — which reads as "no errors" and is the
 * most damaging possible wrong answer.
 *
 * ## References, Rename and Format have no cursor to work from
 *
 * The model never has a live selection — only what `Read` or `Grep` already
 * showed it, a 1-indexed line and its text. So these three take a `path`, a
 * `line`, and the identifier's own `symbol` text rather than a column; the
 * extension finds the column itself by searching the line for that word, and
 * refuses with the exact columns of every match when the line has more than
 * one, rather than guessing.
 *
 * @module tools/vscode
 */

import { currentRunContext } from '../run-context.js';
import type { HostCall, HostToolName } from '../../shared/host-tools.js';

/**
 * Ask the editor, or explain why we cannot.
 *
 * The failure message names the surface rather than the symptom. "No editor is
 * attached" tells a model to stop trying this route and use `Read` and `Bash`;
 * a generic failure invites it to retry the same call three more times, which
 * is what an unhelpful error costs.
 */
async function ask(tool: HostToolName, input: Record<string, unknown>): Promise<unknown> {
  const host = currentRunContext()?.host;
  if (!host) {
    throw new Error(
      `${tool} needs an editor attached to this session. `
      + 'This run has none — use the ordinary file and shell tools instead.',
    );
  }

  const call: Omit<HostCall, 'id'> = { tool, input };
  const answer = await host(call);
  if (!answer.ok) throw new Error(answer.error ?? `${tool} was refused`);
  return answer.result;
}

// ── Diagnostics ──────────────────────────────────────────────────────

export interface DiagnosticsInput {
  /** A file, relative to the project root. Omit for the whole workspace. */
  path?: string;
  /** Lowest severity to report. Defaults to warnings and above. */
  severity?: 'error' | 'warning' | 'info' | 'hint';
  /**
   * How long to let the language server catch up first, in milliseconds.
   *
   * Capped in the extension. A model asked to pick a number will occasionally
   * pick a very large one, and a tool call that blocks a turn for a minute
   * waiting for a linter is worse than a slightly stale answer.
   */
  settleMs?: number;
}

export function vsCodeDiagnostics(input: DiagnosticsInput): Promise<unknown> {
  return ask('VSCodeDiagnostics', { ...input });
}

export const vsCodeDiagnosticsDefinition = {
  name: 'VSCodeDiagnostics',
  description:
    'Read the editor\'s Problems: errors, warnings and hints from the language servers, '
    + 'linters and type checkers the user actually has running. Use this to verify a change '
    + 'instead of guessing, and prefer it to running a full build when you only need to know '
    + 'whether a file is clean. Only available when the session is open in VS Code.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File to check, relative to the project root. Omit for every open problem '
          + 'in the workspace.',
      },
      severity: {
        type: 'string',
        enum: ['error', 'warning', 'info', 'hint'],
        description: 'Lowest severity to include. Defaults to "warning".',
      },
      settleMs: {
        type: 'number',
        description: 'Wait this long for the language server to finish analysing before reading '
          + '(default 600, max 5000). Use it right after an edit: diagnostics arrive '
          + 'asynchronously, and reading immediately reports the state before your change.',
      },
    },
    required: [],
  },
};

// ── Tasks ────────────────────────────────────────────────────────────

export interface TasksInput {
  action: 'list' | 'run';
  /** Task name, as it appears in `tasks.json`. Required to run one. */
  name?: string;
  /** How long to wait for it to finish, in milliseconds. */
  timeoutMs?: number;
}

export function vsCodeTasks(input: TasksInput): Promise<unknown> {
  if (input.action === 'run' && !input.name?.trim()) {
    throw new Error('VSCodeTasks: running a task needs its name. Call it with action "list" first.');
  }
  return ask('VSCodeTasks', { ...input });
}

export const vsCodeTasksDefinition = {
  name: 'VSCodeTasks',
  description:
    'List or run the project\'s configured VS Code tasks — the build, test and watch commands '
    + 'the user has already set up in tasks.json. Prefer this to inventing a command line: a '
    + 'task carries the project\'s own flags, environment and problem matchers, and its output '
    + 'lands in the terminal the user can see. Only available when the session is open in VS Code.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'run'], description: 'What to do.' },
      name: { type: 'string', description: 'Which task, exactly as "list" reported it.' },
      timeoutMs: {
        type: 'number',
        description: 'How long to wait for the task to finish (default 120000, max 600000). '
          + 'A watch task will never finish — list it, do not run it.',
      },
    },
    required: ['action'],
  },
};

// ── Workspace ────────────────────────────────────────────────────────

export interface WorkspaceInput {
  action: 'info' | 'createFolder' | 'addFolder' | 'openFolder';
  /** Where. Relative paths resolve against the project root. */
  path?: string;
}

export function vsCodeWorkspace(input: WorkspaceInput): Promise<unknown> {
  if (input.action !== 'info' && !input.path?.trim()) {
    throw new Error(`VSCodeWorkspace: "${input.action}" needs a path.`);
  }
  return ask('VSCodeWorkspace', { ...input });
}

export const vsCodeWorkspaceDefinition = {
  name: 'VSCodeWorkspace',
  description:
    'Inspect or change what the editor has open: report the workspace folders, create a folder, '
    + 'add one to this workspace, or open one. '
    + 'Use it to finish setting a new project up, so the user lands in it rather than being told '
    + 'to open it themselves. "openFolder" replaces the window and always asks first — the '
    + 'conversation continues, but anything unsaved is the user\'s to deal with. '
    + 'Only available when the session is open in VS Code.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['info', 'createFolder', 'addFolder', 'openFolder'],
        description: 'info: what is currently open. createFolder: make one on disk. '
          + 'addFolder: add it to this multi-root workspace, keeping what is open. '
          + 'openFolder: replace the window with it.',
      },
      path: { type: 'string', description: 'Absolute, or relative to the project root.' },
    },
    required: ['action'],
  },
};

// ── References ───────────────────────────────────────────────────────

export interface ReferencesInput {
  /** File containing the symbol, relative to the project root. */
  path: string;
  /** 1-indexed line the symbol appears on — the same numbering `Read` reports. */
  line: number;
  /** The identifier's exact text, as it appears on that line. */
  symbol: string;
  /**
   * Which occurrence on the line, 1-indexed, when the symbol appears more
   * than once. Omit on the first call; if the line is ambiguous the tool
   * reports the columns and asks for this.
   */
  occurrence?: number;
}

export function vsCodeReferences(input: ReferencesInput): Promise<unknown> {
  if (!input.path?.trim()) throw new Error('VSCodeReferences: needs a path.');
  if (!Number.isInteger(input.line) || input.line < 1) {
    throw new Error('VSCodeReferences: line must be a 1-indexed line number, as Read reports it.');
  }
  if (!input.symbol?.trim()) {
    throw new Error('VSCodeReferences: needs symbol, the identifier\'s exact text on that line.');
  }
  return ask('VSCodeReferences', { ...input });
}

export const vsCodeReferencesDefinition = {
  name: 'VSCodeReferences',
  description:
    'Find every real usage of a symbol — the identifier at a given file and line — using the '
    + 'editor\'s language server, the same "Find All References" the user would run themselves. '
    + 'Prefer this to Grep for a name: it understands scope and imports, and will not match an '
    + 'unrelated identifier that merely shares the same text. Only available when the session is '
    + 'open in VS Code.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File containing the symbol, relative to the project root.' },
      line: { type: 'number', description: '1-indexed line the symbol appears on, as Read reports it.' },
      symbol: { type: 'string', description: 'The identifier\'s exact text, as it appears on that line.' },
      occurrence: {
        type: 'number',
        description: 'If the symbol appears more than once on the line, which occurrence '
          + '(1-indexed). Only needed after a first call reports the ambiguity.',
      },
    },
    required: ['path', 'line', 'symbol'],
  },
};

// ── Rename ───────────────────────────────────────────────────────────

export interface RenameInput {
  path: string;
  line: number;
  symbol: string;
  newName: string;
  occurrence?: number;
}

export function vsCodeRename(input: RenameInput): Promise<unknown> {
  if (!input.path?.trim()) throw new Error('VSCodeRename: needs a path.');
  if (!Number.isInteger(input.line) || input.line < 1) {
    throw new Error('VSCodeRename: line must be a 1-indexed line number, as Read reports it.');
  }
  if (!input.symbol?.trim()) {
    throw new Error('VSCodeRename: needs symbol, the identifier\'s current exact text.');
  }
  if (!input.newName?.trim()) throw new Error('VSCodeRename: needs newName.');
  return ask('VSCodeRename', { ...input });
}

export const vsCodeRenameDefinition = {
  name: 'VSCodeRename',
  description:
    'Rename a symbol everywhere it is used, across every file, using the editor\'s language '
    + 'server — the same "Rename Symbol" and the same accuracy the user would get pressing F2. '
    + 'Every changed file is saved to disk before this returns, so subsequent tools see the real '
    + 'state. Only available when the session is open in VS Code.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File containing the symbol, relative to the project root.' },
      line: { type: 'number', description: '1-indexed line the symbol appears on, as Read reports it.' },
      symbol: { type: 'string', description: 'The identifier\'s current exact text, as it appears on that line.' },
      newName: { type: 'string', description: 'The replacement identifier.' },
      occurrence: {
        type: 'number',
        description: 'If the symbol appears more than once on the line, which occurrence '
          + '(1-indexed). Only needed after a first call reports the ambiguity.',
      },
    },
    required: ['path', 'line', 'symbol', 'newName'],
  },
};

// ── Format ───────────────────────────────────────────────────────────

export interface FormatInput {
  /** File to format, relative to the project root. */
  path: string;
}

export function vsCodeFormat(input: FormatInput): Promise<unknown> {
  if (!input.path?.trim()) throw new Error('VSCodeFormat: needs a path.');
  return ask('VSCodeFormat', { ...input });
}

export const vsCodeFormatDefinition = {
  name: 'VSCodeFormat',
  description:
    'Format one file with whatever formatter is actually configured for it in the user\'s editor '
    + '— their Prettier, Black, gofmt, rustfmt, or whatever "editor.defaultFormatter" says — '
    + 'rather than an opinion of aico\'s own. The file is saved afterward. Only available when '
    + 'the session is open in VS Code.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to format, relative to the project root.' },
    },
    required: ['path'],
  },
};
