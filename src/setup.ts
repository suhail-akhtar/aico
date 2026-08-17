/**
 * Interactive provider setup wizard for aico.
 *
 * Triggered automatically on first run when no provider is configured.
 * Also reachable via:
 *   aico provider add           (CLI subcommand)
 *   /provider add               (slash command inside REPL)
 */

import * as readline from 'readline';
import chalk from 'chalk';
import path from 'path';
import os from 'os';
import { readFile, writeFile, mkdir } from 'fs/promises';

// ── Provider catalogue ───────────────────────────────────────────────

export interface ProviderSpec {
  id:             string;
  name:           string;
  description:    string;
  defaultModel:   string;
  /** If true, wizard asks for an API key */
  requiresKey:    boolean;
  /** Env-var name the key is stored under (also used in settings.env) */
  keyEnv:         string;
  /** Human hint shown below the key prompt */
  keyHint:        string;
  /** If true, wizard optionally asks for a custom base URL */
  requiresUrl?:   boolean;
  urlDefault?:    string;
  urlLabel?:      string;
}

export const PROVIDERS: ProviderSpec[] = [
  {
    id:           'openrouter',
    name:         'OpenRouter',
    description:  'Routes 300+ models. Default: DeepSeek V4 Flash (cheap & fast)',
    defaultModel: 'deepseek/deepseek-v4-flash',
    requiresKey:  true,
    keyEnv:       'OPENROUTER_API_KEY',
    keyHint:      'Get your free key at https://openrouter.ai/keys',
  },
  {
    id:           'anthropic',
    name:         'Anthropic',
    description:  'Claude Sonnet 4.6, Haiku 4.5, Opus 4.6',
    defaultModel: 'claude-sonnet-4-6',
    requiresKey:  true,
    keyEnv:       'ANTHROPIC_API_KEY',
    keyHint:      'Get your key at https://console.anthropic.com',
  },
  {
    id:           'openai',
    name:         'OpenAI',
    description:  'GPT-4o, GPT-4.1, O-series reasoning models',
    defaultModel: 'gpt-4o-mini',
    requiresKey:  true,
    keyEnv:       'OPENAI_API_KEY',
    keyHint:      'Get your key at https://platform.openai.com/api-keys',
  },
  {
    id:           'gemini',
    name:         'Google Gemini',
    description:  'Gemini 2.0 Flash, 1.5 Pro',
    defaultModel: 'gemini-2.0-flash',
    requiresKey:  true,
    keyEnv:       'GEMINI_API_KEY',
    keyHint:      'Get your key at https://aistudio.google.com/app/apikey',
  },
  {
    id:           'zai',
    name:         'Z.AI (GLM)',
    description:  'GLM-4.6, GLM-4.5-Air, GLM-5 — strong coding + agentic models',
    defaultModel: 'glm-4.6',
    requiresKey:  true,
    keyEnv:       'ZAI_API_KEY',
    keyHint:      'Get your key at https://z.ai/manage-apikey',
  },
  {
    id:           'ollama',
    name:         'Ollama  (local)',
    description:  'Run models locally — no API key required',
    defaultModel: 'llama3.1',
    requiresKey:  false,
    keyEnv:       '',
    keyHint:      '',
    requiresUrl:  true,
    urlDefault:   'http://localhost:11434/v1',
    urlLabel:     'Ollama base URL',
  },
];

// ── Check whether any provider is already configured ─────────────────

export function isProviderConfigured(): boolean {
  return !!(
    process.env.OPENROUTER_API_KEY ||
    process.env.ANTHROPIC_API_KEY  ||
    process.env.OPENAI_API_KEY     ||
    process.env.ZAI_API_KEY        ||
    process.env.GEMINI_API_KEY     ||
    process.env.GOOGLE_API_KEY
  );
}

// ── Persistent settings helpers ──────────────────────────────────────

async function readGlobalSettings(): Promise<Record<string, unknown>> {
  const p = path.join(os.homedir(), '.aico', 'settings.json');
  try {
    return JSON.parse(await readFile(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function writeGlobalSettings(data: Record<string, unknown>): Promise<void> {
  const dir = path.join(os.homedir(), '.aico');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'settings.json'), JSON.stringify(data, null, 2));
}

// ── Core wizard ──────────────────────────────────────────────────────

function ask(rl: readline.Interface, q: string): Promise<string> {
  return new Promise(resolve => rl.question(q, resolve));
}

function hr(width = 50) {
  return chalk.gray('─'.repeat(width));
}

/**
 * Run the interactive provider setup wizard.
 *
 * @param existingRl  Pass an existing readline interface from the REPL
 *                    so the wizard can share it (avoids double-reading stdin).
 *                    If omitted, a temporary one is created and closed after.
 */
export async function runProviderSetup(existingRl?: readline.Interface): Promise<void> {
  const ownRl = !existingRl;
  const rl = existingRl ?? readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
    terminal: true,
  });

  try {
    await _wizard(rl);
  } finally {
    if (ownRl) rl.close();
  }
}

async function _wizard(rl: readline.Interface): Promise<void> {
  console.log('');
  console.log(hr());
  console.log(chalk.yellow('  ✻ aico') + chalk.bold(' — Provider Setup'));
  console.log(hr());
  console.log('');
  console.log(chalk.gray('  Connect aico to an AI provider to get started.'));
  console.log(chalk.gray('  Your settings are saved to ') + chalk.white('~/.aico/settings.json'));
  console.log('');

  // ── Step 1: List providers ─────────────────────────────────────────
  console.log(chalk.bold('  Available providers:\n'));
  PROVIDERS.forEach((p, i) => {
    console.log(
      chalk.gray(`  [${i + 1}]  `) +
      chalk.white(p.name.padEnd(16)) +
      chalk.gray(p.description),
    );
  });
  console.log('');

  // ── Step 2: Select provider ────────────────────────────────────────
  let spec: ProviderSpec | undefined;
  while (!spec) {
    const raw = (await ask(rl, chalk.green(`❯ Select provider [1–${PROVIDERS.length}]: `))).trim();
    const idx = parseInt(raw, 10) - 1;
    if (!isNaN(idx) && idx >= 0 && idx < PROVIDERS.length) {
      spec = PROVIDERS[idx];
    } else {
      console.log(chalk.red(`  Please enter a number between 1 and ${PROVIDERS.length}.`));
    }
  }

  console.log('');
  console.log(chalk.gray(`  Configuring `) + chalk.white(spec.name) + chalk.gray(' …'));
  console.log('');

  const existing = await readGlobalSettings();
  const providers = (existing.providers ?? {}) as Record<string, Record<string, string>>;
  const providerEntry: Record<string, string> = providers[spec.id] ?? {};

  // ── Step 3: Collect API key ────────────────────────────────────────
  if (spec.requiresKey) {
    console.log(chalk.gray(`  ${spec.keyHint}`));
    console.log('');

    let key = '';
    while (!key) {
      const raw = (await ask(rl, chalk.green(`❯ ${spec.name} API key: `))).trim();
      if (raw) {
        key = raw;
      } else {
        console.log(chalk.red('  API key is required.'));
      }
    }
    providerEntry.apiKey = key;
    // Also inject immediately so the rest of this session works
    process.env[spec.keyEnv] = key;
    console.log('');
  }

  // ── Step 4: Ollama base URL (optional for others) ─────────────────
  if (spec.requiresUrl) {
    const label   = spec.urlLabel ?? 'Base URL';
    const default_ = spec.urlDefault ?? 'http://localhost:11434/v1';
    const raw = (await ask(rl, chalk.green(`❯ ${label} [${default_}]: `))).trim();
    providerEntry.baseUrl = raw || default_;
    console.log('');
  }

  // ── Step 5: Default model (with sensible default) ─────────────────
  const modelDefault = providerEntry.defaultModel ?? spec.defaultModel;
  const rawModel = (await ask(
    rl,
    chalk.green(`❯ Default model [${modelDefault}]: `),
  )).trim();
  if (rawModel) providerEntry.defaultModel = rawModel;
  else          providerEntry.defaultModel = modelDefault;

  console.log('');

  // ── Step 6: Save ──────────────────────────────────────────────────
  providers[spec.id]     = providerEntry;
  existing.providers     = providers;
  existing.provider      = spec.id;
  existing.model         = providerEntry.defaultModel;

  await writeGlobalSettings(existing);

  console.log(hr());
  console.log(
    chalk.green('  ✓ ') +
    chalk.white(spec.name) +
    chalk.gray(' saved to ') +
    chalk.white('~/.aico/settings.json'),
  );
  console.log(chalk.gray(`  Default model: `) + chalk.white(providerEntry.defaultModel));
  console.log(hr());
  console.log('');
}

// ── List all configured providers ────────────────────────────────────

export async function listConfiguredProviders(): Promise<string> {
  const settings = await readGlobalSettings();
  const active   = (settings.provider as string | undefined) ?? '(none)';
  const stored   = (settings.providers ?? {}) as Record<string, Record<string, string>>;

  const lines: string[] = [
    chalk.bold('  Configured providers:'),
    '',
  ];

  const envKeys: Record<string, string | undefined> = {
    openrouter: process.env.OPENROUTER_API_KEY,
    anthropic:  process.env.ANTHROPIC_API_KEY,
    openai:     process.env.OPENAI_API_KEY,
    zai:        process.env.ZAI_API_KEY,
    gemini:     process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY,
  };

  for (const spec of PROVIDERS) {
    const isActive   = spec.id === active;
    const inSettings = !!stored[spec.id]?.apiKey || spec.id === 'ollama';
    const inEnv      = !!envKeys[spec.id];
    const configured = inSettings || inEnv;

    const bullet  = isActive ? chalk.yellow('▶') : chalk.gray('○');
    const nameStr = isActive ? chalk.white(spec.name) : chalk.gray(spec.name);
    const source  = configured
      ? (inSettings ? chalk.green('settings') : chalk.cyan('env'))
      : chalk.gray('not set');
    const model   = stored[spec.id]?.defaultModel ?? spec.defaultModel;

    lines.push(`  ${bullet}  ${nameStr.padEnd(22)}${source.padEnd(20)}${chalk.gray(model)}`);
  }

  lines.push('');
  lines.push(chalk.gray('  Run ') + chalk.white('/provider add') + chalk.gray(' to add or update a provider.'));

  return lines.join('\n');
}
