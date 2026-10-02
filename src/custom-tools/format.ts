/**
 * The custom tool format: a typed JSON wrapper around one command (an argv
 * array) or one HTTP call, declared by a person and validated here.
 *
 * WHY. "Wrap `helm diff`, typed, with a credential" should not need someone to
 * write an MCP server, and the alternative the agent already had — Bash with
 * a command string — is exactly what makes argument injection, secret leaks
 * and "the model decided this was harmless" possible. A custom tool fixes the
 * program and its shape in trusted configuration; the model fills in typed
 * values and nothing else (design §5.2, ADR 0009).
 *
 * The rules this module enforces, all before anything is spawned:
 *
 *  - **A placeholder is a whole argv element.** `{field}` replaces one element
 *    and nothing else; a `{field}` embedded in a longer element is a
 *    definition error. There is never a shell or string concatenation.
 *  - **Values are validated against `input_schema`** (a deliberately small
 *    subset: flat objects of string/number/integer/boolean, `pattern`, `enum`,
 *    bounds), with `additionalProperties: false` required so a model cannot
 *    smuggle a field the author never declared.
 *  - **A free-text string is conservative.** A string with neither `pattern`
 *    nor `enum` may not contain shell metacharacters, control characters or a
 *    `..` path segment — the author opts out by writing a pattern.
 *  - **A value that looks like a flag is refused** unless its schema sets
 *    `allowFlagLike: true`, which closes `--kubeconfig=/evil`.
 *  - **Secrets are references** (`{{secret:name}}`, `{{secret-file:name}}`),
 *    allowed only as a whole `env` value or HTTP header value; the model never
 *    supplies one through an argument.
 *
 * Pure: no I/O, no imports from the tool graph. Name collisions are checked
 * by the caller, which knows the built-in names.
 *
 * Deliberately not here: nested objects or arrays in arguments, shell
 * strings, a templating language, `concurrency` (custom tools are exclusive,
 * like every tool the loop does not know), import/export of packs.
 *
 * @module custom-tools/format
 */

export const EFFECTS = ['read', 'write', 'exec', 'external', 'destructive'] as const;
export type Effect = (typeof EFFECTS)[number];
export type ApprovalOverride = 'none' | 'first-use' | 'every-use';

export interface PropertySchema {
  type: 'string' | 'number' | 'integer' | 'boolean';
  description?: string;
  pattern?: string;
  enum?: Array<string | number>;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  /** Let a string value begin with `-`. Off by default: that is argument injection. */
  allowFlagLike?: boolean;
}

export interface InputSchema {
  type: 'object';
  properties: Record<string, PropertySchema>;
  required?: string[];
  additionalProperties: false;
}

export interface RunSpec {
  argv: string[];
  /** `${workspace}` is the run's directory; relative paths resolve against it. */
  cwd?: string;
  /** Literal values, or exactly `{{secret:name}}` / `{{secret-file:name}}`. */
  env?: Record<string, string>;
  timeoutSec?: number;
}

export interface HttpSpec {
  method: string;
  /** `{field}` placeholders are URL-encoded values. */
  url: string;
  /** Literal values, `{field}`, or exactly `{{secret:name}}`. */
  headers?: Record<string, string>;
  /** JSON; a string leaf that is exactly `{field}` becomes that typed value. */
  body?: unknown;
  timeoutSec?: number;
}

export interface CustomToolDef {
  name: string;
  description: string;
  input_schema: InputSchema;
  run?: RunSpec;
  http?: HttpSpec;
  effect: Effect;
  approval?: ApprovalOverride;
  preview?: { tool: string; args?: 'same' };
  output?: { maxChars?: number };
  /** Proves the binary exists; run only by `test`, never during a turn. */
  probe?: string[];
}

export const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const PACK_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const WHOLE_PLACEHOLDER_RE = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const ANY_PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
/** `{{secret:name}}` / `{{secret:name.field}}` and the temp-file form, as a whole value. */
export const SECRET_REF_RE = /^\{\{\s*(secret|secret-file):([A-Za-z0-9][A-Za-z0-9_-]{0,63})(?:\.([A-Za-z][A-Za-z0-9_]{0,31}))?\s*\}\}$/;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

export const DEFAULT_TIMEOUT_SEC = 60;
export const MAX_TIMEOUT_SEC = 3600;
export const DEFAULT_MAX_CHARS = 20_000;
export const MAX_MAX_CHARS = 200_000;
const MAX_STRING = 4096;

/** Characters a free-text (pattern-less) string may not carry: shell syntax and control characters. */
const FREE_TEXT_FORBIDDEN = /[;&|$`<>\r\n\0\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** A `..` path segment, in either separator. */
const TRAVERSAL = /(^|[\\/])\.\.([\\/]|$)/;
/** Control characters, refused whatever the pattern says: no author means "newline in an argument". */
const CONTROL = /[\r\n\0\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export interface DefinitionReport {
  def?: CustomToolDef;
  errors: string[];
  warnings: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A secret reference in a value, parsed; undefined when the value is not one. */
export function parseSecretRef(value: string): { kind: 'secret' | 'secret-file'; ref: string } | undefined {
  const m = SECRET_REF_RE.exec(value);
  if (!m) return undefined;
  return { kind: m[1] as 'secret' | 'secret-file', ref: m[3] ? `${m[2]}.${m[3]}` : m[2]! };
}

function checkSchema(raw: unknown, errors: string[]): InputSchema | undefined {
  if (!isRecord(raw)) { errors.push('input_schema is missing — give {"type":"object","properties":{…},"additionalProperties":false}.'); return undefined; }
  if (raw.type !== 'object') errors.push('input_schema.type must be "object".');
  if (raw.additionalProperties !== false) {
    errors.push('input_schema.additionalProperties must be false, so the model cannot pass a field you did not declare.');
  }
  const props = raw.properties ?? {};
  if (!isRecord(props)) { errors.push('input_schema.properties must be an object of fields.'); return undefined; }
  for (const [field, spec] of Object.entries(props)) {
    if (!FIELD_RE.test(field)) errors.push(`input_schema field "${field}": use letters, digits and _ (starting with a letter or _).`);
    if (!isRecord(spec)) { errors.push(`input_schema field "${field}" must be an object with a "type".`); continue; }
    const type = spec.type;
    if (type !== 'string' && type !== 'number' && type !== 'integer' && type !== 'boolean') {
      errors.push(`input_schema field "${field}": type must be string, number, integer or boolean (nested objects and arrays are not supported — write an MCP server for those).`);
      continue;
    }
    if (spec.pattern !== undefined) {
      if (type !== 'string' || typeof spec.pattern !== 'string') errors.push(`input_schema field "${field}": pattern is for string fields and must be a string.`);
      else {
        try { new RegExp(spec.pattern, 'u'); } catch (err) { errors.push(`input_schema field "${field}": pattern does not compile (${(err as Error).message}).`); }
        if (!spec.pattern.startsWith('^') || !spec.pattern.endsWith('$')) {
          errors.push(`input_schema field "${field}": anchor the pattern with ^…$, or it matches any value that merely contains a match.`);
        }
      }
    }
    if (spec.enum !== undefined) {
      if (!Array.isArray(spec.enum) || spec.enum.length === 0) errors.push(`input_schema field "${field}": enum must be a non-empty list.`);
      else if (spec.enum.some(v => (type === 'string' ? typeof v !== 'string' : typeof v !== 'number'))) {
        errors.push(`input_schema field "${field}": every enum value must be a ${type === 'string' ? 'string' : 'number'}.`);
      }
    }
    if (spec.allowFlagLike !== undefined && typeof spec.allowFlagLike !== 'boolean') errors.push(`input_schema field "${field}": allowFlagLike is true or false.`);
  }
  const required = raw.required ?? [];
  if (!Array.isArray(required) || required.some(r => typeof r !== 'string')) errors.push('input_schema.required must be a list of field names.');
  else for (const r of required) if (!(r in props)) errors.push(`input_schema.required names "${r}", which is not a field.`);
  return raw as unknown as InputSchema;
}

/** Placeholders in one argv element: the whole-element field, or embedded ones (an error). */
function placeholdersIn(element: string, fields: Set<string>): { whole?: string; embedded: string[] } {
  const whole = WHOLE_PLACEHOLDER_RE.exec(element)?.[1];
  if (whole && fields.has(whole)) return { whole, embedded: [] };
  const embedded = [...element.matchAll(ANY_PLACEHOLDER_RE)].map(m => m[1]!).filter(f => fields.has(f));
  return { embedded };
}

function checkTimeout(value: unknown, where: string, errors: string[]): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_SEC) {
    errors.push(`${where}.timeoutSec must be a whole number of seconds from 1 to ${MAX_TIMEOUT_SEC}.`);
  }
}

/**
 * Validate a definition. `fileName` and `pack`, when given, must agree with
 * it; `reserved` are names it may not take (built-ins, other tools).
 */
export function validateDefinition(raw: unknown, opts: { reserved?: ReadonlySet<string> } = {}): DefinitionReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(raw)) return { errors: ['A custom tool is a JSON object.'], warnings };

  const name = raw.name;
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    errors.push('name must be lower-case letters, digits and _ (1–64, starting with a letter), e.g. k8s_helm_diff.');
  } else if (opts.reserved?.has(name) || name.startsWith('mcp__')) {
    errors.push(`name "${name}" is taken by a built-in tool or another custom tool — prefix it with the pack (e.g. ${'myteam_' + name}).`);
  } else if (!name.includes('_')) {
    warnings.push(`name "${name}" has no pack prefix; one (e.g. k8s_…) keeps it from colliding with tools added later.`);
  }

  const description = raw.description;
  if (typeof description !== 'string' || description.trim().length === 0) errors.push('description is required: say what it does and when to use it.');
  else if (description.length > 1024) errors.push(`description is ${description.length} characters; the limit is 1,024 — say less, or move detail into the field descriptions.`);

  const fieldErrors: string[] = [];
  const schema = checkSchema(raw.input_schema, fieldErrors);
  errors.push(...fieldErrors);
  const fields = new Set(Object.keys(schema?.properties ?? {}));

  const effect = raw.effect;
  if (typeof effect !== 'string' || !(EFFECTS as readonly string[]).includes(effect)) {
    errors.push(`effect must be one of ${EFFECTS.join(', ')} — it decides when a person is asked.`);
  }

  if (raw.run !== undefined && raw.http !== undefined) errors.push('Give either run (a command) or http (an API call), not both.');
  if (raw.run === undefined && raw.http === undefined) errors.push('Give a runner: run {argv:[…]} for a command, or http {method,url} for an API call.');

  if (raw.run !== undefined) {
    const run = raw.run;
    if (!isRecord(run)) errors.push('run must be an object with argv.');
    else {
      const argv = run.argv;
      if (!Array.isArray(argv) || argv.length === 0 || argv.some(a => typeof a !== 'string')) {
        errors.push('run.argv must be a non-empty list of strings: the program, then each argument as its own element.');
      } else {
        const program = argv[0] as string;
        if (!program.trim() || placeholdersIn(program, fields).whole || placeholdersIn(program, fields).embedded.length) {
          errors.push('run.argv[0] is the program and must be fixed, not a placeholder.');
        }
        argv.forEach((element, i) => {
          if (typeof element !== 'string') return;
          if (/\{\{\s*secret/.test(element)) errors.push(`run.argv[${i}]: secrets never go in arguments (they are visible to every process on the machine) — put them in env.`);
          const found = placeholdersIn(element, fields);
          if (found.embedded.length) {
            errors.push(`run.argv[${i}] "${element}": a placeholder must be a whole argv element — split it, e.g. ["--namespace", "{namespace}"].`);
          }
        });
      }
      if (run.cwd !== undefined && typeof run.cwd !== 'string') errors.push('run.cwd must be a string (use ${workspace} for the run\'s folder).');
      if (run.env !== undefined) {
        if (!isRecord(run.env)) errors.push('run.env must be an object of NAME: value.');
        else for (const [k, v] of Object.entries(run.env)) {
          if (!ENV_NAME_RE.test(k)) errors.push(`run.env "${k}" is not a valid variable name.`);
          if (typeof v !== 'string') { errors.push(`run.env "${k}" must be a string.`); continue; }
          if (!parseSecretRef(v) && /\{\{/.test(v)) errors.push(`run.env "${k}": a secret reference must be the whole value, exactly {{secret:name}} or {{secret-file:name}}.`);
        }
      }
      checkTimeout(run.timeoutSec, 'run', errors);
    }
  }
  if (raw.http !== undefined) {
    const http = raw.http;
    if (!isRecord(http)) errors.push('http must be an object with method and url.');
    else {
      if (typeof http.method !== 'string' || !METHODS.has(http.method.toUpperCase())) errors.push(`http.method must be one of ${[...METHODS].join(', ')}.`);
      if (typeof http.url !== 'string' || !/^https?:\/\//i.test(http.url)) errors.push('http.url must start with https:// (or http:// for a private address).');
      else {
        if (/\{\{/.test(http.url)) errors.push('http.url: secrets never go in the URL (servers log URLs) — use a header.');
        try { new URL(http.url.replace(ANY_PLACEHOLDER_RE, 'x')); } catch { errors.push('http.url is not a valid URL.'); }
        const host = /^https?:\/\/([^/?#]*)/i.exec(http.url)?.[1] ?? '';
        if (/\{[A-Za-z_][A-Za-z0-9_]*\}/.test(host)) errors.push('http.url: the host is fixed by the definition; placeholders belong in the path or query.');
      }
      if (http.headers !== undefined) {
        if (!isRecord(http.headers)) errors.push('http.headers must be an object.');
        else for (const [k, v] of Object.entries(http.headers)) {
          if (typeof v !== 'string') { errors.push(`http.headers "${k}" must be a string.`); continue; }
          const ref = parseSecretRef(v);
          if (ref?.kind === 'secret-file') errors.push(`http.headers "${k}": a secret-file is for commands; use {{secret:name}} in a header.`);
          else if (!ref && /\{\{/.test(v)) errors.push(`http.headers "${k}": a secret reference must be the whole value.`);
        }
      }
      checkTimeout(http.timeoutSec, 'http', errors);
    }
  }

  if (raw.approval !== undefined) {
    const a = raw.approval;
    if (a !== 'none' && a !== 'first-use' && a !== 'every-use') errors.push('approval must be none, first-use or every-use.');
    else if (effect === 'destructive' && a !== 'every-use') errors.push('approval cannot relax a destructive tool: a person approves every call.');
    else if (a === 'none' && effect !== 'external' && effect !== 'read') errors.push('approval "none" can relax only an external tool; write and exec follow the session\'s approval mode.');
  }
  if (raw.preview !== undefined) {
    const p = raw.preview;
    if (!isRecord(p) || typeof p.tool !== 'string' || !NAME_RE.test(p.tool) || (p.args !== undefined && p.args !== 'same')) {
      errors.push('preview must be {"tool": "<a read custom tool>", "args": "same"}.');
    } else if (effect === 'read') warnings.push('preview is shown on approval cards; a read tool never asks, so it is unused.');
  }
  if (raw.output !== undefined) {
    const max = isRecord(raw.output) ? raw.output.maxChars : undefined;
    if (!isRecord(raw.output) || (max !== undefined && (typeof max !== 'number' || !Number.isInteger(max) || max < 1000 || max > MAX_MAX_CHARS))) {
      errors.push(`output.maxChars must be a whole number from 1,000 to ${MAX_MAX_CHARS.toLocaleString('en-US')}.`);
    }
  }
  if (raw.probe !== undefined && (!Array.isArray(raw.probe) || raw.probe.length === 0 || raw.probe.some(a => typeof a !== 'string'))) {
    errors.push('probe must be an argv list, e.g. ["helm", "version", "--short"].');
  }
  const known = new Set(['name', 'description', 'input_schema', 'run', 'http', 'effect', 'approval', 'preview', 'output', 'probe']);
  for (const key of Object.keys(raw)) if (!known.has(key)) warnings.push(`"${key}" is not part of the format and is ignored.`);

  return errors.length ? { errors, warnings } : { def: raw as unknown as CustomToolDef, errors, warnings };
}

// ── arguments ────────────────────────────────────────────────────────

/**
 * Validate call arguments against the schema. Returns the problems, each
 * naming the fix; empty means the call may be rendered.
 */
export function validateArgs(schema: InputSchema, args: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const props = schema.properties ?? {};
  for (const key of Object.keys(args)) {
    if (!(key in props)) problems.push(`"${key}" is not a parameter of this tool (it takes: ${Object.keys(props).join(', ') || 'nothing'}).`);
  }
  for (const r of schema.required ?? []) {
    if (args[r] === undefined || args[r] === null) problems.push(`"${r}" is required.`);
  }
  for (const [key, spec] of Object.entries(props)) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    switch (spec.type) {
      case 'boolean':
        if (typeof value !== 'boolean') problems.push(`"${key}" must be true or false.`);
        break;
      case 'number':
      case 'integer':
        if (typeof value !== 'number' || !Number.isFinite(value) || (spec.type === 'integer' && !Number.isInteger(value))) {
          problems.push(`"${key}" must be ${spec.type === 'integer' ? 'a whole number' : 'a number'}.`);
          break;
        }
        if (spec.minimum !== undefined && value < spec.minimum) problems.push(`"${key}" must be at least ${spec.minimum}.`);
        if (spec.maximum !== undefined && value > spec.maximum) problems.push(`"${key}" must be at most ${spec.maximum}.`);
        if (spec.enum && !spec.enum.includes(value)) problems.push(`"${key}" must be one of ${spec.enum.join(', ')}.`);
        break;
      case 'string': {
        if (typeof value !== 'string') { problems.push(`"${key}" must be a string.`); break; }
        if (value.length > (spec.maxLength ?? MAX_STRING)) problems.push(`"${key}" is ${value.length} characters; the limit is ${spec.maxLength ?? MAX_STRING}.`);
        if (spec.minLength !== undefined && value.length < spec.minLength) problems.push(`"${key}" must be at least ${spec.minLength} characters.`);
        if (CONTROL.test(value)) { problems.push(`"${key}" contains a newline or control character, which is never passed to a command.`); break; }
        if (value.startsWith('-') && !spec.allowFlagLike) {
          problems.push(`"${key}" begins with "-", which the program would read as an option — refused (the tool's author can allow it with allowFlagLike).`);
          break;
        }
        if (spec.enum) {
          if (!spec.enum.includes(value)) problems.push(`"${key}" must be one of ${spec.enum.join(', ')}.`);
          break;
        }
        if (spec.pattern) {
          if (!new RegExp(spec.pattern, 'u').test(value)) problems.push(`"${key}" does not match ${spec.pattern}.`);
          break;
        }
        // Free text: the author wrote no pattern, so be conservative.
        if (FREE_TEXT_FORBIDDEN.test(value)) {
          problems.push(`"${key}" contains shell syntax (; & | $ \` < >), which a free-text parameter may not — if the value is legitimate, the tool's author can give the field a pattern that allows it.`);
        } else if (TRAVERSAL.test(value)) {
          problems.push(`"${key}" contains a ".." path segment, which a free-text parameter may not — refer to the path directly, or the author can give the field a pattern.`);
        }
        break;
      }
    }
  }
  return problems;
}

/** A value as one argv element. */
function asArg(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

/**
 * The argv for one call. Each `{field}` element becomes exactly one element;
 * an element for an absent optional field is dropped. Never joins, never
 * quotes — quoting is the spawner's business, and only on Windows shims.
 */
export function renderArgv(argv: readonly string[], args: Record<string, unknown>, fields: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const element of argv) {
    const field = WHOLE_PLACEHOLDER_RE.exec(element)?.[1];
    // Not a declared field: a literal that happens to have braces (a jq filter, say).
    if (field === undefined || !fields.has(field)) { out.push(element); continue; }
    const value = args[field];
    // An optional field the call did not give: its element is dropped.
    if (value === undefined || value === null) continue;
    out.push(asArg(value));
  }
  return out;
}

/** The declared fields of a definition. */
export function fieldsOf(def: CustomToolDef): Set<string> {
  return new Set(Object.keys(def.input_schema?.properties ?? {}));
}

/** An HTTP request for one call: URL values encoded, `{field}` header values and JSON leaves substituted. */
export function renderHttp(spec: HttpSpec, args: Record<string, unknown>): { method: string; url: string; headers: Record<string, string>; json?: unknown } {
  const url = spec.url.replace(ANY_PLACEHOLDER_RE, (whole, field: string) => (
    Object.prototype.hasOwnProperty.call(args, field) && args[field] !== undefined ? encodeURIComponent(asArg(args[field])) : ''
  ));
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.headers ?? {})) {
    const field = WHOLE_PLACEHOLDER_RE.exec(v)?.[1];
    if (field !== undefined) {
      if (args[field] !== undefined && args[field] !== null) headers[k] = asArg(args[field]);
    } else headers[k] = v;
  }
  const fill = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const field = WHOLE_PLACEHOLDER_RE.exec(node)?.[1];
      return field !== undefined && Object.prototype.hasOwnProperty.call(args, field) ? args[field] : node;
    }
    if (Array.isArray(node)) return node.map(fill);
    if (isRecord(node)) return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fill(v)]));
    return node;
  };
  return {
    method: spec.method.toUpperCase(), url, headers,
    ...(spec.body !== undefined ? { json: fill(spec.body) } : {}),
  };
}

/** The command line as a person reads it on an approval card: secrets by name, never by value. */
export function describeCall(def: CustomToolDef, args: Record<string, unknown>): string {
  const show = (a: string): string => (/[\s"']/.test(a) || a === '' ? JSON.stringify(a) : a);
  if (def.run) {
    const lines = [`$ ${renderArgv(def.run.argv, args, fieldsOf(def)).map(show).join(' ')}`];
    const env = Object.entries(def.run.env ?? {});
    if (env.length) lines.push(`env: ${env.map(([k, v]) => `${k}=${parseSecretRef(v) ? v : show(v)}`).join(' ')}`);
    return lines.join('\n');
  }
  const req = renderHttp(def.http!, args);
  const lines = [`${req.method} ${req.url}`];
  for (const [k, v] of Object.entries(req.headers)) lines.push(`${k}: ${v}`);
  if (req.json !== undefined) lines.push(JSON.stringify(req.json).slice(0, 600));
  return lines.join('\n');
}
