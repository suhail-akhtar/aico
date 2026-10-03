/**
 * "Save as…" for terminal commands: a script file, a custom tool draft, or a
 * request to schedule them.
 *
 * WHY. The commands that worked are the ones people want again — the build
 * incantation, the deploy check — and retyping them from history is how a
 * flag gets lost. Turning them into something durable must not also turn a
 * token pasted on the command line into a file in the repo, so:
 *
 *  - **commands only, never output**, and every command passes
 *    `redactCommand` (secret shapes become `[masked …]`, and the builder says
 *    so, pointing at `{{secret:NAME}}`);
 *  - a **custom tool is one argv, no shell** (ADR 0009): a command that needs
 *    a shell (pipes, redirection, `&&`, variables) is refused with the fix —
 *    save a script and wrap that. Tokens the person marks become typed string
 *    parameters (`{field}` as a whole argv element, exactly the format's
 *    rule); the result is a *draft* a person still has to enable;
 *  - **a schedule is a request to the agent**, whose cron tool confirms the
 *    schedule — there is no route that creates a job without that.
 *
 * Pure; the panel shows `preview` before anything is written.
 *
 * @module desktop/shared/terminal-export
 */

import { redactCommand } from './terminal-redact';

export interface ExportCommand { command: string; cwd: string }

export interface ScriptResult { text: string; masked: number; ext: 'ps1' | 'sh' }

const quotePs = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const quoteSh = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

function maskCount(before: string, after: string): number {
  return before === after ? 0 : (after.match(/\[masked [^\]]+\]/g) ?? []).length;
}

/**
 * A script that runs the commands in order, changing directory when the
 * recorded working directory changes, and stopping at the first failure.
 */
export function buildScript(o: { commands: ExportCommand[]; kind: 'ps1' | 'sh'; title: string; date: string }): ScriptResult {
  let masked = 0;
  const lines: string[] = [];
  const head = [
    `Saved from the AICO terminal "${o.title.replace(/[\r\n]/g, ' ')}" on ${o.date}.`,
    'Commands only; their output was not saved. Values that looked like secrets are [masked]:',
    'put them in the vault and pass them as environment variables instead of typing them here.',
  ];
  if (o.kind === 'ps1') {
    lines.push(...head.map(h => `# ${h}`), '$ErrorActionPreference = \'Stop\'', '$PSNativeCommandUseErrorActionPreference = $true', '');
  } else {
    lines.push('#!/usr/bin/env bash', ...head.map(h => `# ${h}`), 'set -euo pipefail', '');
  }
  let at = '';
  for (const c of o.commands) {
    if (c.cwd && c.cwd !== at) {
      lines.push(o.kind === 'ps1' ? `Set-Location -LiteralPath ${quotePs(c.cwd)}` : `cd ${quoteSh(c.cwd)}`);
      at = c.cwd;
    }
    const clean = redactCommand(c.command);
    masked += maskCount(c.command, clean);
    lines.push(clean);
    if (o.kind === 'ps1') lines.push('if ($LASTEXITCODE) { exit $LASTEXITCODE }');
  }
  return { text: `${lines.join('\n')}\n`, masked, ext: o.kind };
}

// ── custom tools ──

/** Shell syntax a no-shell argv cannot carry, outside quotes. */
const SHELL_SYNTAX = /[|<>;&`]|\$\(|\$\{|\$[A-Za-z_]|^\s*\(|\)\s*$/;

export type Tokenized = { ok: true; argv: string[] } | { ok: false; error: string };

/**
 * Split a command line into argv the way a POSIX shell or PowerShell would
 * for simple commands: whitespace separates, '…' is literal, "…" groups
 * (backslash escapes `"` and `\` inside it). Anything that needs a real
 * shell is refused, naming the fix.
 */
export function tokenizeCommand(command: string): Tokenized {
  const src = command.trim();
  if (!src) return { ok: false, error: 'The command is empty.' };
  if (/[\r\n]/.test(src)) return { ok: false, error: 'A custom tool wraps one single-line command. Save several lines as a script, then wrap the script.' };
  const argv: string[] = [];
  let cur = '';
  let has = false;
  let i = 0;
  let outside = '';
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) return { ok: false, error: 'Unbalanced single quote.' };
      cur += src.slice(i + 1, end); has = true; i = end + 1; continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let buf = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && (src[j + 1] === '"' || src[j + 1] === '\\')) { buf += src[j + 1]; j += 2; continue; }
        if (src[j] === '$' || src[j] === '`') return { ok: false, error: 'The command expands a variable or a sub-command inside double quotes, which needs a shell. Save it as a script and wrap the script.' };
        buf += src[j]; j++;
      }
      if (j >= src.length) return { ok: false, error: 'Unbalanced double quote.' };
      cur += buf; has = true; i = j + 1; continue;
    }
    if (/\s/.test(ch)) {
      if (has) { argv.push(cur); cur = ''; has = false; }
      outside += ' ';
      i++; continue;
    }
    cur += ch; has = true; outside += ch; i++;
  }
  if (has) argv.push(cur);
  if (SHELL_SYNTAX.test(outside)) {
    return { ok: false, error: 'The command uses shell syntax (a pipe, redirection, &&, ; or a variable). A custom tool runs one program without a shell — save the commands as a script and wrap the script instead.' };
  }
  return { ok: true, argv };
}

export interface ToolParam { index: number; name: string; description?: string }

export interface ToolDraft {
  name: string;
  description: string;
  effect: 'read' | 'write' | 'exec' | 'external' | 'destructive';
  input_schema: { type: 'object'; properties: Record<string, { type: 'string'; description?: string }>; required: string[]; additionalProperties: false };
  run: { argv: string[]; cwd?: string; timeoutSec: number };
}

const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** A tool name from the command: `npm run build` → `npm_run_build`. */
export function suggestToolName(argv: string[]): string {
  const words = argv.slice(0, 3).map(a => a.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1|sh)$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')).filter(Boolean);
  let name = words.join('_').replace(/^[^a-z]+/, '').slice(0, 48);
  if (!NAME_RE.test(name)) name = 'terminal_command';
  return name;
}

/**
 * A custom tool definition for one command. `params` mark argv positions
 * that become `{name}` fields. `cwd` is `${workspace}` or an absolute path.
 */
export function buildCustomTool(o: {
  command: string; name: string; description: string; effect?: ToolDraft['effect']; params?: ToolParam[]; cwd?: string;
}): { ok: true; def: ToolDraft; masked: number } | { ok: false; error: string } {
  const clean = redactCommand(o.command);
  const masked = maskCount(o.command, clean);
  if (masked) return { ok: false, error: 'The command contains a value that looks like a secret. A custom tool takes secrets as {{secret:NAME}} environment values — remove it from the command first.' };
  const t = tokenizeCommand(clean);
  if (!t.ok) return t;
  if (!NAME_RE.test(o.name)) return { ok: false, error: 'The tool name must be lower-case letters, digits and _, starting with a letter.' };
  if (!o.description.trim()) return { ok: false, error: 'Describe what the tool does — it is what the agent reads to decide when to use it.' };
  const argv = [...t.argv];
  const properties: ToolDraft['input_schema']['properties'] = {};
  const seen = new Set<string>();
  for (const p of o.params ?? []) {
    if (p.index <= 0 || p.index >= argv.length) return { ok: false, error: 'Only arguments after the program can become parameters.' };
    if (!FIELD_RE.test(p.name)) return { ok: false, error: `"${p.name}" is not a parameter name (letters, digits and _).` };
    if (seen.has(p.name)) return { ok: false, error: `Two parameters are called "${p.name}".` };
    seen.add(p.name);
    argv[p.index] = `{${p.name}}`;
    properties[p.name] = { type: 'string', ...(p.description?.trim() ? { description: p.description.trim() } : {}) };
  }
  return {
    ok: true,
    masked: 0,
    def: {
      name: o.name,
      description: o.description.trim(),
      effect: o.effect ?? 'exec',
      input_schema: { type: 'object', properties, required: [...seen], additionalProperties: false },
      run: { argv, ...(o.cwd ? { cwd: o.cwd } : {}), timeoutSec: 600 },
    },
  };
}

// ── schedules ──

/** The chat message that asks the agent to schedule the commands (its cron tool confirms). */
export function buildSchedulePrompt(o: { commands: ExportCommand[]; schedule: string }): { text: string; masked: number } {
  let masked = 0;
  const body = o.commands.map((c) => {
    const clean = redactCommand(c.command);
    masked += maskCount(c.command, clean);
    return `cd ${c.cwd}\n${clean}`;
  });
  const lines = [
    `Schedule this as a recurring job: ${o.schedule.trim() || '(ask me how often)'}.`,
    'Use the scheduling tool and confirm the schedule and what each run will do before creating it.',
    'Each run executes these terminal commands in order (they worked when I ran them), stops at the first failure, and reports what failed:',
    '```text',
    ...body,
    '```',
  ];
  return { text: lines.join('\n'), masked };
}
