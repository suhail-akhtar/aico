/**
 * `ToolManage`: list, read, create, update, validate, test, enable, disable
 * and delete custom tools — one executor for the agent, the HTTP panel
 * (`POST /api/manage {registry:'tools'}`) and the terminal (`aico tool`).
 *
 * **Creating does not enable.** `create` and `update` write a draft in the
 * user's store (`~/.aico/tools/<pack>/`); it is not callable until a person
 * enables it, and enabling binds to the file's hash (store.ts). The model may
 * write a tool; it may not switch one on — `enable` from the model, or from
 * the API token without a proven person, is refused, the same rule as skills.
 *
 * **`test` executes only for a person, and only read tools.** It always
 * validates and renders the exact argv (a dry run); with a person behind it,
 * it also runs the probe and, for a read tool, the call itself with the
 * arguments they typed. Anything that writes, executes or deploys runs only
 * from a turn, through its approval — never from a test button.
 *
 * Lives in the deferred `registry` group, so it costs nothing in the
 * always-sent request (design §4.5). Project tools are not written here:
 * they are files in the repository, reviewed through project trust.
 *
 * @module custom-tools/manage
 */

import fs from 'node:fs';
import path from 'node:path';
import { currentCwd } from '../run-context.js';
import { extensionDecision } from '../policy/enforce.js';
import { sinkRedact } from '../vault/sink.js';
import { NAME_RE, PACK_RE, describeCall, validateArgs, validateDefinition, type CustomToolDef } from './format.js';
import { runCustomTool, runProbe } from './runner.js';
import {
  TOOL_FILE_SUFFIX, forgetTool, loadCustomTools, setToolEnabled, userToolsDir, type LoadedTool,
} from './store.js';

export interface ToolManageInput {
  action: 'list' | 'read' | 'create' | 'update' | 'validate' | 'test' | 'enable' | 'disable' | 'delete';
  name?: string;
  /** For create: the pack folder (the deferred group `tools:<pack>`). */
  pack?: string;
  /** For create/update/validate: the tool definition. */
  definition?: Record<string, unknown>;
  /** For test: sample arguments. */
  args?: Record<string, unknown>;
}

/** `human`: the caller proved a person (decision gate, an interactive terminal). */
export interface ToolManageContext { human?: boolean; cwd?: string }

const needsPerson = (name: string): string =>
  `Not enabled: a person enables "${name}" after reading it — Settings → Tools, or \`aico tool enable ${name}\` in a terminal. You cannot enable it yourself.`;

function line(t: LoadedTool): string {
  const what = t.def ? `${t.def.effect}${t.def.run ? ' command' : ' HTTP'}` : 'invalid';
  return `- ${t.name} (${t.scope === 'project' ? 'project' : 'yours'}, pack ${t.pack}) — ${what} · ${t.status}${t.reason ? ` (${t.reason})` : ''}`
    + (t.errors.length ? `\n    errors: ${t.errors.join(' | ')}` : '');
}

function find(all: LoadedTool[], name: string | undefined): LoadedTool | undefined {
  return name ? all.find(t => t.name === name) ?? all.find(t => path.basename(t.file, TOOL_FILE_SUFFIX) === name) : undefined;
}

function report(errors: string[], warnings: string[]): string {
  return [
    errors.length ? `Errors (fix these):\n${errors.map(e => `- ${e}`).join('\n')}` : 'Valid.',
    warnings.length ? `Warnings:\n${warnings.map(w => `- ${w}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

async function reserved(all: LoadedTool[], except?: string): Promise<Set<string>> {
  const { toolDefinitions } = await import('../tools/index.js');
  return new Set([
    ...toolDefinitions.map(d => d.name), 'Task', 'Investigate', 'LoadTools', 'ToolManage',
    ...all.filter(t => t.name !== except && t.status !== 'invalid').map(t => t.name),
  ]);
}

export async function executeToolManage(input: ToolManageInput, ctx: ToolManageContext = {}): Promise<string> {
  const cwd = ctx.cwd ?? currentCwd();
  const all = await loadCustomTools(cwd);
  const action = input.action;

  switch (action) {
    case 'list': {
      if (all.length === 0) {
        return 'No custom tools. A custom tool wraps one command (argv) or one HTTP call with typed parameters; '
          + 'create one with action "create" (it starts as a draft a person enables).';
      }
      return `Custom tools (load a pack with LoadTools to call its tools):\n${all.map(line).join('\n')}`;
    }

    case 'read': {
      const t = find(all, input.name);
      if (!t) return `No custom tool called "${input.name ?? ''}". ${all.length ? `There are: ${all.map(x => x.name).join(', ')}.` : ''}`;
      let text = '';
      try { text = fs.readFileSync(t.file, 'utf8'); } catch { /* reported as unreadable below */ }
      return `${line(t)}\nfile: ${t.file}\n${text || '(unreadable)'}`;
    }

    case 'validate': {
      if (input.definition) {
        const r = validateDefinition(input.definition, { reserved: await reserved(all, String(input.definition.name ?? '')) });
        return report(r.errors, r.warnings);
      }
      const t = find(all, input.name);
      if (!t) return `No custom tool called "${input.name ?? ''}". Give a name, or a definition to check.`;
      return report(t.errors, t.warnings);
    }

    case 'create':
    case 'update': {
      const def = input.definition;
      if (!def || typeof def !== 'object') return 'A definition is required: {name, description, input_schema, run|http, effect, …}.';
      const name = String(def.name ?? '');
      if (!NAME_RE.test(name)) return 'Not written: name must be lower-case letters, digits and _ (starting with a letter).';
      // The organisation's policy (ADR 0035): creating or changing a tool is refused where it forbids them.
      const allowed = extensionDecision('customTools', name);
      if (!allowed.ok) return `Not written: ${allowed.message}`;
      const existing = find(all, name);
      if (action === 'create' && existing) return `Not written: "${name}" already exists (${existing.file}). Use action "update" to change it.`;
      if (action === 'update' && (!existing || existing.scope !== 'user')) {
        return `Not written: there is no tool "${name}" in your tools to update${existing ? ' (project tools are files in the repository — edit them there)' : ''}.`;
      }
      const pack = action === 'update' ? existing!.pack : String(input.pack ?? '');
      if (!PACK_RE.test(pack)) return 'Not written: give a pack (lower-case letters, digits and -), e.g. "k8s". It is the group LoadTools loads.';
      const r = validateDefinition(def, { reserved: await reserved(all, name) });
      if (r.errors.length) return `Not written.\n${report(r.errors, r.warnings)}`;
      const file = action === 'update' ? existing!.file : path.join(userToolsDir(), pack, `${name}${TOOL_FILE_SUFFIX}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(def, null, 2)}\n`, 'utf8');
      return `${action === 'create' ? 'Draft written' : 'Updated'}: ${file}. It is not callable until a person enables it `
        + `(Settings → Tools, or \`aico tool enable ${name}\`)${action === 'update' && existing?.status === 'enabled' ? ' — the change took it out of use until then' : ''}.`
        + (r.warnings.length ? `\n${report([], r.warnings)}` : '');
    }

    case 'test': {
      const t = find(all, input.name);
      if (!t) return `No custom tool called "${input.name ?? ''}".`;
      if (!t.def) return `Not valid.\n${report(t.errors, t.warnings)}`;
      const def: CustomToolDef = t.def;
      const args = input.args ?? {};
      const out: string[] = [`Valid. ${def.effect} tool, ${t.status}.`];
      const problems = validateArgs(def.input_schema, args);
      if (problems.length) {
        out.push(`Arguments refused: ${problems.join(' ')}`);
        return out.join('\n');
      }
      out.push(`Would run:\n${describeCall(def, args)}`);
      if (!ctx.human) {
        out.push('Dry run only: a person runs the probe and read tools from Settings → Tools or `aico tool test`.');
        return out.join('\n');
      }
      if (t.status === 'untrusted') { out.push(`Not executed: ${t.reason}.`); return out.join('\n'); }
      const probe = await runProbe(def, cwd);
      out.push(`Probe: ${probe.ok ? 'ok' : 'FAILED'} — ${probe.detail}`);
      if (def.effect !== 'read') {
        out.push(`Not executed: a ${def.effect} tool runs only from a turn, through its approval.`);
        return out.join('\n');
      }
      const result = sinkRedact(await runCustomTool(def, args, { cwd }));
      const text = JSON.stringify(result, null, 2);
      out.push(`Result:\n${text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text}`);
      return out.join('\n');
    }

    case 'enable': {
      const t = find(all, input.name);
      if (!t) return `No custom tool called "${input.name ?? ''}".`;
      if (!t.def) return `Not enabled: it is not valid.\n${report(t.errors, t.warnings)}`;
      if (!ctx.human) return needsPerson(t.name);
      if (t.status === 'untrusted') return `Not enabled: ${t.reason}.`;
      setToolEnabled(t, true);
      return `Enabled "${t.name}" (${t.def.effect}). The model can load it with LoadTools (group tools:${t.pack}).`;
    }

    case 'disable': {
      const t = find(all, input.name);
      if (!t) return `No custom tool called "${input.name ?? ''}".`;
      setToolEnabled(t, false);
      return `Disabled "${t.name}". It is out of every run until a person enables it again.`;
    }

    case 'delete': {
      const t = find(all, input.name);
      if (!t) return `No custom tool called "${input.name ?? ''}".`;
      if (t.scope !== 'user') return 'Not deleted: project tools are files in the repository — remove them there.';
      if (t.status === 'enabled' && !ctx.human) return `Not deleted: "${t.name}" is enabled; a person deletes enabled tools (Settings → Tools). Disable it, or ask them.`;
      fs.rmSync(t.file, { force: true });
      forgetTool(t.file);
      try { if (fs.readdirSync(path.dirname(t.file)).length === 0) fs.rmdirSync(path.dirname(t.file)); } catch { /* an empty pack folder left behind is harmless */ }
      return `Deleted "${t.name}".`;
    }

    default:
      return `Unknown action "${String(action)}". Actions: list, read, create, update, validate, test, enable, disable, delete.`;
  }
}

/** For the Settings panel: every tool, structured. Definitions hold secret *names* only. */
export async function toolsForPanel(cwd: string = process.cwd()): Promise<Array<Omit<LoadedTool, 'def'> & { def?: CustomToolDef; command?: string }>> {
  return (await loadCustomTools(cwd)).map(t => ({ ...t, ...(t.def ? { command: describeCall(t.def, {}) } : {}) }));
}

export const toolManageToolDefinition = {
  name: 'ToolManage',
  description: 'Manage custom tools: typed wrappers around one command (argv, never a shell string) or one HTTP call, '
    + 'stored as JSON in ~/.aico/tools/<pack>/. create/update write a DRAFT that a person enables before it can be called; '
    + 'you cannot enable one yourself. Use this when someone asks for a reusable, typed command (e.g. wrap `helm diff`), '
    + 'or what custom tools exist. Secrets go in env/headers as {{secret:name}} (or {{secret-file:name}} for a file path), never in argv.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'read', 'create', 'update', 'validate', 'test', 'enable', 'disable', 'delete'],
        description: 'test: validate and show the exact argv it would run (a dry run).',
      },
      name: { type: 'string', description: 'The tool\'s name.' },
      pack: { type: 'string', description: 'For create: the pack folder, e.g. "k8s" (loaded as group tools:k8s).' },
      definition: {
        type: 'object',
        description: 'For create/update/validate: {name, description, input_schema:{type:"object",properties:{…},required:[…],additionalProperties:false}, '
          + 'run:{argv:["prog","{field}",…],cwd?,env?,timeoutSec?} | http:{method,url,headers?,body?}, '
          + 'effect: read|write|exec|external|destructive, approval?, preview?:{tool,args:"same"}, output?:{maxChars}, probe?:[argv]}. '
          + 'Each {field} is one whole argv element.',
      },
      args: { type: 'object', description: 'For test: sample arguments.' },
    },
    required: ['action'],
  },
};
