import {
  ensureWorkspace,
  formatWorkspaceInfo,
  listWorkspace,
  readWorkspaceFile,
  setProjectWorkspacePath,
  writeWorkspaceFile,
} from '../workspace.js';

export const workspaceInfoToolDefinition = {
  name: 'WorkspaceInfo',
  description: 'Show the current AICO project/session workspace paths for artifacts, reports, logs, and scratch files.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const workspaceSetPathToolDefinition = {
  name: 'WorkspaceSetPath',
  description: 'Configure the project workspace path. Use an absolute path or project-relative path. Omit path to reset to the home-based default workspace.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or project-relative workspace path. Omit or empty string to reset to the home-based default.' },
    },
    required: [],
  },
};

export const workspaceWriteToolDefinition = {
  name: 'WorkspaceWrite',
  description: 'Write an artifact, report, log, or scratch file inside the AICO workspace. Path is always relative to the selected workspace scope.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path inside the workspace scope, e.g. reports/qa-report.md.' },
      content: { type: 'string', description: 'UTF-8 text content to write.' },
      scope: { type: 'string', enum: ['session', 'common'], description: 'session stores under the current session directory; common stores under shared project workspace.' },
    },
    required: ['path', 'content'],
  },
};

export const workspaceReadToolDefinition = {
  name: 'WorkspaceRead',
  description: 'Read a UTF-8 text file from the AICO workspace. Path is relative to the selected workspace scope.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path inside the workspace scope.' },
      scope: { type: 'string', enum: ['session', 'common'], description: 'session or common workspace scope.' },
    },
    required: ['path'],
  },
};

export const workspaceListToolDefinition = {
  name: 'WorkspaceList',
  description: 'List files under the AICO workspace session or common scope.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Optional relative path to list.' },
      scope: { type: 'string', enum: ['session', 'common'], description: 'session or common workspace scope.' },
    },
    required: [],
  },
};

export const capabilityReportToolDefinition = {
  name: 'CapabilityReport',
  description: 'Report AICO current capabilities: tools, slash commands, workspace, settings, MCP servers, and execution powers.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export async function executeWorkspaceInfo(): Promise<string> {
  return formatWorkspaceInfo(await ensureWorkspace());
}

export async function executeWorkspaceSetPath(args: { path?: string }): Promise<string> {
  const value = args.path?.trim() || undefined;
  return setProjectWorkspacePath(value);
}

export async function executeWorkspaceWrite(args: { path: string; content: string; scope?: 'session' | 'common' }): Promise<string> {
  const result = await writeWorkspaceFile({
    path: args.path,
    content: args.content,
    scope: args.scope ?? 'session',
  });
  return `Wrote ${result.bytes} byte(s) to ${result.path}`;
}

export async function executeWorkspaceRead(args: { path: string; scope?: 'session' | 'common' }): Promise<string> {
  return readWorkspaceFile({
    path: args.path,
    scope: args.scope ?? 'session',
  });
}

export async function executeWorkspaceList(args: { path?: string; scope?: 'session' | 'common' }): Promise<string> {
  return listWorkspace({
    path: args.path,
    scope: args.scope ?? 'session',
  });
}
