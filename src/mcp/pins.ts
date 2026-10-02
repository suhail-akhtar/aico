/**
 * Pinned MCP tool definitions — the rug-pull defence (design §5.3, Phase 6).
 *
 * A server's tool description is text the model reads as guidance. A server
 * that was approved with an honest description can change it later ("rug
 * pull") to tell the model to read `~/.ssh` and pass it along, and nothing
 * would notice: the new text simply arrived on the next `tools/list`.
 *
 * So each tool's `(name, description, inputSchema)` is hashed and pinned when
 * it is approved. A listing whose hash differs from its pin removes that tool
 * from what the agent is offered and can call, until a person re-approves it
 * (`/mcp-approve`, or Settings with the decision gate's proof of a person —
 * never the model through `McpManage`). New tools on a server that already
 * has pins wait the same way unless the server's settings say
 * `"trust": "trusted"`.
 *
 * **First sight pins everything** (trust on first use). The server's config
 * was itself approved by a person — adding one asks, and a project's servers
 * need workspace trust — so its tools as first listed are what was approved.
 *
 * **Where pins live.** `<AICO_HOME>/mcp/pins.json`, not the settings entry the
 * design sketched: settings files can be committed and shared, and a pin is
 * one person's approval, like workspace trust (`workspace-trust.json`). A
 * shared file would let a repository ship pins that pre-approve whatever its
 * server later says. The pinned description and schema are kept beside the
 * hash so a reviewer can be shown what changed.
 *
 * The desktop's own host server is not pinned: its tools are AICO's code.
 *
 * @module mcp/pins
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { aicoHome } from '../home.js';

export interface PinnedTool {
  hash: string;
  description: string;
  inputSchema: Record<string, unknown>;
  approvedAt: string;
}

interface PinFile {
  version: 1;
  servers: Record<string, Record<string, PinnedTool>>;
}

/** The parts of a tool that are pinned. */
export interface PinnableTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function pinsPath(): string {
  return path.join(aicoHome(), 'mcp', 'pins.json');
}

/** JSON with object keys sorted, so a server reordering keys is not a change. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function toolHash(tool: PinnableTool): string {
  return `sha256:${crypto.createHash('sha256').update(canonical({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })).digest('hex')}`;
}

function read(): PinFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(pinsPath(), 'utf8')) as PinFile;
    if (parsed && parsed.version === 1 && parsed.servers && typeof parsed.servers === 'object') return parsed;
  } catch { /* no file yet, or unreadable: start empty (every server is then first-seen) */ }
  return { version: 1, servers: {} };
}

function write(file: PinFile): void {
  const target = pinsPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2));
  fs.renameSync(tmp, target);
}

function pinOf(tool: PinnableTool): PinnedTool {
  return { hash: toolHash(tool), description: tool.description, inputSchema: tool.inputSchema, approvedAt: new Date().toISOString() };
}

/** A tool held back from the agent, and why. */
export interface HeldTool<T extends PinnableTool = PinnableTool> {
  tool: T;
  reason: 'changed' | 'new';
  /** What was approved, for a `changed` tool. */
  pinned?: PinnedTool;
}

export interface ToolReview<T extends PinnableTool> {
  allowed: T[];
  held: Array<HeldTool<T>>;
}

/**
 * Sort a server's listing into what the agent may use and what waits for a
 * person. Writes pins only for first sight and for new tools on a trusted server.
 */
export function reviewServerTools<T extends PinnableTool>(server: string, tools: readonly T[], opts: { trusted?: boolean } = {}): ToolReview<T> {
  const file = read();
  const pins = file.servers[server];
  if (!pins) {
    file.servers[server] = Object.fromEntries(tools.map(t => [t.name, pinOf(t)]));
    write(file);
    return { allowed: [...tools], held: [] };
  }
  const allowed: T[] = [];
  const held: Array<HeldTool<T>> = [];
  let dirty = false;
  for (const tool of tools) {
    const pin = pins[tool.name];
    if (!pin) {
      if (opts.trusted) { pins[tool.name] = pinOf(tool); dirty = true; allowed.push(tool); }
      else held.push({ tool, reason: 'new' });
    } else if (pin.hash === toolHash(tool)) {
      allowed.push(tool);
    } else {
      held.push({ tool, reason: 'changed', pinned: pin });
    }
  }
  if (dirty) write(file);
  return { allowed, held };
}

/** Pin the current definitions of `tools` (a person's approval). Returns the names pinned. */
export function approveTools(server: string, tools: readonly PinnableTool[]): string[] {
  const file = read();
  const pins = (file.servers[server] ??= {});
  for (const t of tools) pins[t.name] = pinOf(t);
  write(file);
  return tools.map(t => t.name);
}

/** Forget a server's pins (it was removed; a new server under the name starts fresh). */
export function forgetServerPins(server: string): void {
  const file = read();
  if (!(server in file.servers)) return;
  delete file.servers[server];
  write(file);
}

/** A short, human-readable account of what changed, for review. */
export function describeChange(held: HeldTool): string {
  if (held.reason === 'new') return `new tool, not yet approved:\n    description: ${held.tool.description.slice(0, 600)}`;
  const before = held.pinned!;
  const lines = [`changed since it was approved on ${before.approvedAt.slice(0, 10)}:`];
  if (before.description !== held.tool.description) {
    lines.push(`    approved description: ${before.description.slice(0, 600)}`, `    current description:  ${held.tool.description.slice(0, 600)}`);
  }
  if (canonical(before.inputSchema) !== canonical(held.tool.inputSchema)) {
    lines.push(`    approved schema: ${canonical(before.inputSchema).slice(0, 600)}`, `    current schema:  ${canonical(held.tool.inputSchema).slice(0, 600)}`);
  }
  return lines.join('\n');
}
