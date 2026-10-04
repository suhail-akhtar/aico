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
 * **What is hashed.** Name, description, input schema, and (when the server
 * sends them) the tool's `title` and `annotations`: both are shown to the
 * model or a person, so a server that changed them after approval was not
 * caught. A tool without them hashes exactly as before. A pin written before
 * they were hashed (no `fields: 2`) whose old hash still matches is upgraded
 * in place on first sight (the same trust-on-first-use as the pin itself).
 *
 * **Whose pins.** Pins are kept by server name, and each server's entry
 * records which command (or URL) it was approved for. A different command
 * under the same name is a different program: its tools are held as new until
 * a person approves them, rather than inheriting the old server's approval.
 * Entries written before the identity was recorded adopt the current one.
 *
 * @module mcp/pins
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { aicoHome } from '../home.js';

export interface PinnedTool {
  hash: string;
  /** 2: the hash covers title and annotations. Absent: written before they were. */
  fields?: 2;
  description: string;
  inputSchema: Record<string, unknown>;
  approvedAt: string;
}

interface PinFile {
  version: 1;
  servers: Record<string, Record<string, PinnedTool>>;
  /** Per server name: the command or URL its pins were approved for (`serverIdentity`). */
  identities?: Record<string, string>;
}

/** The parts of a tool that are pinned. */
export interface PinnableTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  title?: string;
  annotations?: object;
}

/** What a server's pins are bound to: its command and arguments, or its URL. */
export function serverIdentity(config: { command?: string; args?: readonly unknown[]; url?: string; type?: string } | undefined): string | undefined {
  if (!config) return undefined;
  if (config.command) return `cmd:${canonical([config.command, ...(config.args ?? []).map(String)])}`;
  if (config.url) return `url:${config.type ?? 'http'}:${config.url}`;
  return undefined;
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
  return `sha256:${crypto.createHash('sha256').update(canonical({
    name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
    ...(tool.title !== undefined ? { title: tool.title } : {}),
    ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
  })).digest('hex')}`;
}

/** The hash pins were written with before title and annotations were covered. */
function legacyHash(tool: PinnableTool): string {
  return toolHash({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
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
  return { hash: toolHash(tool), fields: 2, description: tool.description, inputSchema: tool.inputSchema, approvedAt: new Date().toISOString() };
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
export function reviewServerTools<T extends PinnableTool>(server: string, tools: readonly T[], opts: { trusted?: boolean; identity?: string } = {}): ToolReview<T> {
  const file = read();
  let pins = file.servers[server];
  const known = file.identities?.[server];
  if (!pins) {
    file.servers[server] = Object.fromEntries(tools.map(t => [t.name, pinOf(t)]));
    if (opts.identity) (file.identities ??= {})[server] = opts.identity;
    write(file);
    return { allowed: [...tools], held: [] };
  }
  let dirty = false;
  if (opts.identity && known === undefined) {
    // Pins from before identities were recorded belong to what runs now.
    (file.identities ??= {})[server] = opts.identity;
    dirty = true;
  } else if (opts.identity && known !== opts.identity) {
    // Same name, different program: nothing it lists was approved.
    pins = {};
  }
  const replaced = pins !== file.servers[server];
  const allowed: T[] = [];
  const held: Array<HeldTool<T>> = [];
  for (const tool of tools) {
    const pin = pins[tool.name];
    if (!pin) {
      if (opts.trusted && !replaced) { pins[tool.name] = pinOf(tool); dirty = true; allowed.push(tool); }
      else held.push({ tool, reason: 'new' });
    } else if (pin.hash === toolHash(tool)) {
      allowed.push(tool);
    } else if (pin.fields !== 2 && pin.hash === legacyHash(tool)) {
      // Approved before title/annotations were hashed: adopt them now.
      pins[tool.name] = { ...pinOf(tool), approvedAt: pin.approvedAt };
      dirty = true;
      allowed.push(tool);
    } else {
      held.push({ tool, reason: 'changed', pinned: pin });
    }
  }
  if (dirty) write(file);
  return { allowed, held };
}

/** Pin the current definitions of `tools` (a person's approval). Returns the names pinned. */
export function approveTools(server: string, tools: readonly PinnableTool[], identity?: string): string[] {
  const file = read();
  if (identity && file.identities?.[server] !== undefined && file.identities[server] !== identity) {
    // A person approved the new program's tools: its pins replace the old one's.
    file.servers[server] = {};
  }
  if (identity) (file.identities ??= {})[server] = identity;
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
  if (file.identities) delete file.identities[server];
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
