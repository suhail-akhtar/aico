import 'dotenv/config';
import { personaFor } from './agents/resolve.js';
import { createRequire } from 'node:module';
import { Command } from 'commander';
import * as readline from 'readline';
import chalk from 'chalk';
import { runAgent } from './agent.js';
import { showError } from './ui.js';
import { resetPermissions } from './permissions.js';
import {
  generateSessionId,
  appendMessage,
  saveSession,
  loadLastSession,
  loadSession,
  listSessions,
} from './history.js';
import { loadSettings } from './settings.js';
import { createTokenTracker, estimateTokens } from './tokens.js';
import { maybeAutoCompactConversation as sharedMaybeAutoCompactConversation } from './compact.js';
import { handleSlashCommand } from './commands.js';
import { freezeHooks, runHooks } from './hooks.js';
import { skillRegistry } from './skills/index.js';
import { initializeFeatures, shutdownFeatures } from './bootstrap.js';
import { mcpRegistry } from './mcp/index.js';
import { cronScheduler } from './cron/scheduler.js';
import { stopMemoryWatcher, setMemoryCacheTtl } from './memory/index.js';
import { setBackgroundAgentOpts } from './background/index.js';
import { setNotificationHookSettings } from './background/notifications.js';
import { selectProvider, PROVIDER_DEFAULT_MODELS, detectProviderType } from './providers/index.js';
import { runProviderSetup, isProviderConfigured, listConfiguredProviders } from './setup.js';
import { ensureWorkspace, setWorkspaceRuntime } from './workspace.js';
import { runPipeline } from './studio/pipeline.js';
import { readState } from './studio/state.js';
import { createStudioRuntime } from './studio/runtime.js';
import { Inbox, maybeCompactSession, openSession, seedFromLegacyHistory } from './session/index.js';

/** Resolve model aliases and short names to full model IDs */
function resolveModel(model: string, settings?: { providers?: { openrouter?: { defaultModel?: string }; anthropic?: { defaultModel?: string }; openai?: { defaultModel?: string }; gemini?: { defaultModel?: string }; ollama?: { defaultModel?: string } } }): string {
  const aliases: Record<string, string> = {
    // Claude aliases
    haiku:      'claude-haiku-4.5',
    sonnet:     'claude-sonnet-4-6',
    opus:       'claude-opus-4-6',
    'haiku-4':  'claude-haiku-4.5',
    'sonnet-4': 'claude-sonnet-4-6',
    'opus-4':   'claude-opus-4-6',
    'claude':   'claude-sonnet-4-6',
    // OpenAI aliases
    gpt4:  'gpt-4o',
    'gpt-4': 'gpt-4o',
    gpt41: 'gpt-4.1',
    mini:  'gpt-4o-mini',
    // DeepSeek aliases (via OpenRouter)
    'deepseek-flash': 'deepseek/deepseek-v4-flash',
    'deepseek-pro':   'deepseek/deepseek-v4-pro',
    'deepseek':       'deepseek/deepseek-v4-flash',
    'ds-flash':       'deepseek/deepseek-v4-flash',
    'ds-pro':         'deepseek/deepseek-v4-pro',
    'ds-v4':          'deepseek/deepseek-v4-flash',
    'ds-v4-pro':      'deepseek/deepseek-v4-pro',
    // Gemini aliases
    gemini:       'gemini-2.0-flash',
    'gemini-pro': 'gemini-1.5-pro',
    'gemini-flash': 'gemini-2.0-flash',
    // Z.AI GLM aliases
    glm:          'glm-4.6',
    'glm-4':      'glm-4.6',
    'glm-5':      'glm-5',
    'glm-52':     'glm-5.2',
    'glm-flash':  'glm-4.5-air',
    zai:          'glm-4.6',
  };
  // Strip z.ai/ prefix if present (Z.AI API expects bare model IDs)
  const resolved = aliases[model.toLowerCase()] ?? model;
  return resolved.replace(/^z-?ai\//i, '');
}

/**
 * Compact whichever store the model actually reads.
 *
 * With a session log attached the request is derived from the log, so
 * compacting the plain message array would shrink something nothing reads and
 * leave the real context growing without bound. The array is still trimmed on
 * the legacy path, and kept in sync for the command surfaces that display it.
 */
function maybeAutoCompactConversation(
  messages: Array<{ role: string; content: string }>,
  settings: Awaited<ReturnType<typeof loadSettings>>,
  model?: string,
  session?: import('./session/index.js').Session,
): number | undefined {
  if (session) {
    const result = maybeCompactSession(session, settings, model);
    return result.compacted ? result.tokensAfter : undefined;
  }
  return sharedMaybeAutoCompactConversation(messages, settings, model);
}

/**
 * Choose the best default model based on configured providers.
 * Returns a full model ID string.
 */
function defaultModel(): string {
  if (process.env.OPENROUTER_API_KEY) return PROVIDER_DEFAULT_MODELS.openrouter;
  if (process.env.ANTHROPIC_API_KEY)  return PROVIDER_DEFAULT_MODELS.anthropic;
  if (process.env.OPENAI_API_KEY)     return PROVIDER_DEFAULT_MODELS.openai;
  if (process.env.ZAI_API_KEY)        return PROVIDER_DEFAULT_MODELS.zai;
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return PROVIDER_DEFAULT_MODELS.gemini;
  return PROVIDER_DEFAULT_MODELS.openrouter; // will error gracefully if no key
}

/** Build effort-level hint string appended to the user message */
function buildEffortHint(effort: string | undefined): string {
  if (!effort || effort === 'medium') return '';
  const hints: Record<string, string> = {
    low: 'Be concise and fast. Prefer the simplest working solution.',
    high: 'Be thorough and detailed. Explore edge cases and document your work.',
    max: 'Use maximum effort. Explore all options exhaustively. Leave nothing unchecked.',
  };
  const hint = hints[effort] ?? '';
  return hint ? `\n\n[Effort: ${effort}. ${hint}]` : '';
}

export interface CLIOptions {
  file?: string;
  model: string;
  plan: boolean;
  yes: boolean;
  verbose: boolean;
  print?: boolean;
  continue?: boolean;
  /** Session ID string, or true when flag given without a value (triggers interactive picker) */
  resume?: string | boolean;
  permissionMode?: string;
  dangerouslySkipPermissions?: boolean;
  effort?: string;
  name?: string;
  agent?: string;
}

const program = new Command();

/** Single source of truth for the reported version is package.json */
const nodeRequire = createRequire(import.meta.url);
const pkgJson = nodeRequire('../package.json') as {
  version: string; name: string; repository?: unknown;
};
const pkgVersion: string = pkgJson.version;

/**
 * Say if a newer AICO exists, and start finding out for next time.
 *
 * Two halves on purpose. The notice comes from the previous run's cached
 * answer, so it costs a file read; the refresh is fired and deliberately not
 * awaited, so nothing a person is waiting on ever includes a network round
 * trip. One run of lag on hearing about a release, in exchange for never
 * slowing anything down.
 *
 * Someone running through `npx` is the reason this exists: they are pinned to
 * whatever was cached the first time and have no installed package to notice
 * is out of date.
 */
async function announceUpdate(): Promise<void> {
  try {
    const { pendingUpdate, refreshUpdateCache, updateNotice } = await import('./update-check.js');
    const latest = await pendingUpdate(pkgVersion);
    if (latest) console.log(chalk.dim(`\n  ${updateNotice(pkgVersion, latest, pkgJson.name)}\n`));
    void refreshUpdateCache(pkgJson.repository);
  } catch {
    // A version check is never worth interrupting the tool for.
  }
}

program
  // Options after a subcommand belong to that subcommand.
  //
  // Without this, `aico serve -p 7399` silently ignored the port and bound
  // 7317: the program declares `-p, --print` for Claude Code compatibility,
  // and it shadowed serve's own `-p, --port`. The failure was quiet in the
  // worst way — the flag was accepted, the documented short form, and the
  // server simply started somewhere else.
  .enablePositionalOptions()
  .name('aico')
  .description('AI Coder — multi-provider coding assistant (Claude Code compatible)')
  .version(pkgVersion)
  .argument('[prompt]', 'Run a single task non-interactively (like claude -p)')
  .option('-f, --file <path>', 'attach file context')
  .option(
    '-m, --model <model>',
    'model: deepseek-flash | deepseek-pro | haiku | sonnet | opus | gpt-4o | gemini | glm | or any full model ID',
    '',  // resolved dynamically in action handler
  )
  .option('--plan', 'show plan before executing', false)
  .option('-y, --yes', 'auto-approve all tool calls', false)
  .option('-v, --verbose', 'show verbose tool call details', false)
  .option('-p, --print', 'non-interactive: print response and exit')
  .option('-c, --continue', 'continue the most recent conversation')
  .option('-r, --resume [id]', 'resume a session by ID (omit ID for interactive picker)')
  .option(
    '--permission-mode <mode>',
    'permission mode: default | acceptEdits | bypassPermissions | dontAsk',
    'default',
  )
  .option('--dangerously-skip-permissions', 'bypass ALL permission checks', false)
  .option('--effort <level>', 'effort level: low | medium | high | max', 'medium')
  .option('-n, --name <name>', 'display name for this session')
  .option('--agent <name>', 'talk to a specific agent: devops | devsecops | review | project | security-audit | backend | frontend | qa | or a custom agent name')
  .action(async (prompt: string | undefined) => {
    const opts = program.opts<CLIOptions>();

    // Load settings first so provider API keys from settings are injected into env
    const settings = await loadSettings();

    // ── First-run: no provider configured → run setup wizard ──────────
    if (!isProviderConfigured() && !settings.provider && settings.providers === undefined) {
      console.log('');
      console.log(chalk.yellow('  ✻ aico') + chalk.gray(' — no provider configured yet.'));
      await runProviderSetup();
      // Reload settings so the newly saved key/model are picked up
      const fresh = await loadSettings();
      Object.assign(settings, fresh);
    }

    // Resolve model: CLI flag → settings → auto-detect from provider
    const rawModel = opts.model || settings.model || defaultModel();
    opts.model = resolveModel(rawModel);
    if (settings.model) settings.model = resolveModel(settings.model);

    // Resolve --agent flag: prepend the agent's system prompt to the task
    // so the user chats directly with that agent persona.
    const KNOWN_AGENT_TYPES = new Set([
      'general', 'explore', 'plan', 'verification', 'security-audit',
      'project', 'devops', 'devsecops', 'review',
      'frontend', 'backend', 'qa', 'architect',
      'tech-writer', 'product-owner', 'healer',
    ]);
    let agentPrefix = '';
    if (opts.agent) {
      const { AGENT_PROMPTS } = await import('./agents/prompts-registry.js');
      const agentKey = opts.agent.toLowerCase();
      if (AGENT_PROMPTS[agentKey as keyof typeof AGENT_PROMPTS]) {
        agentPrefix = AGENT_PROMPTS[agentKey as keyof typeof AGENT_PROMPTS] + '\n\n---\n\n';
      } else {
        // Try loading a registered custom agent spec
        try {
          const { getAgentSpec } = await import('./agents/registry.js');
          const spec = await getAgentSpec(opts.agent);
          if (spec?.systemPromptXml) {
            agentPrefix = spec.systemPromptXml + '\n\n---\n\n';
          }
        } catch { /* not a registered agent */ }
      }
    }

    // Auto-approve if dangerously-skip-permissions or bypassPermissions mode
    if (
      opts.dangerouslySkipPermissions ||
      opts.permissionMode === 'bypassPermissions' ||
      opts.permissionMode === 'dontAsk'
    ) {
      opts.yes = true;
    }

    if (prompt || opts.print) {
      await runSingleTask(agentPrefix + (prompt ?? ''), opts, settings);
    } else {
      // For REPL mode, the agent prefix is applied to each task in the REPL loop
      (opts as CLIOptions & { _agentPrefix?: string })._agentPrefix = agentPrefix;
      await startREPL(opts, settings);
    }
  });

program
  .command('run <task>')
  .description('run a single task non-interactively')
  .action(async (task: string) => {
    const opts = program.opts<CLIOptions>();
    const settings = await loadSettings();
    const rawModel = opts.model || settings.model || defaultModel();
    opts.model = resolveModel(rawModel);
    if (settings.model) settings.model = resolveModel(settings.model);
    await runSingleTask(task, opts, settings);
  });

program
  .command('serve')
  .description('serve the web interface on localhost')
  .option('-p, --port <port>', 'port to listen on', '7317')
  .option('--no-open', 'do not open a browser')
  .action(async (cmdOpts: { port: string; open?: boolean }) => {
    const { serve } = await import('./server/index.js');
    const { url, close } = await serve({
      port: Number(cmdOpts.port),
      open: cmdOpts.open !== false,
    });

    // The token is printed once and not stored. It gates a process that can run
    // shell commands as you, so it should not sit in a file for the next thing
    // that reads your home directory.
    console.log(`\n  AICO is serving at:\n\n    ${url}\n`);
    console.log(cmdOpts.open === false
      ? '  Open that link — the token in it is what authorises the page.'
      : '  Opening your browser. If it did not open, use the link above —\n'
        + '  the token in it is what authorises the page.');
    console.log('\n  Bound to 127.0.0.1 only. Ctrl-C to stop.\n');
    await announceUpdate();

    const shutdown = async (): Promise<void> => {
      console.log('\n  Stopping — flushing session logs…');
      await close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  });

program
  .command('mcp-serve')
  .description('speak MCP on stdin/stdout, so another AI can hand aico work')
  .option('-C, --cwd <dir>', 'directory the work runs in')
  .option('--allow-writes', 'let submitted work run commands and change files')
  .action(async (cmdOpts: { cwd?: string; allowWrites?: boolean }) => {
    // Nothing may be printed before this point. stdout is the protocol stream
    // from the moment the client spawns us, and a banner in it is a parse error
    // at the other end rather than a cosmetic problem.
    const { serveMcpOverStdio } = await import('./mcp-server/index.js');
    await serveMcpOverStdio({
      ...(cmdOpts.cwd ? { cwd: cmdOpts.cwd } : {}),
      ...(cmdOpts.allowWrites ? { allowWrites: true } : {}),
    });
    process.exit(0);
  });

// ── provider subcommand ───────────────────────────────────────────────
const providerCmd = program
  .command('provider')
  .description('manage AI provider configuration');

providerCmd
  .command('add')
  .description('add or update a provider (interactive wizard)')
  .action(async () => {
    await runProviderSetup();
    process.exit(0);
  });

providerCmd
  .command('list')
  .description('list configured providers')
  .action(async () => {
    await loadSettings(); // inject env from settings first
    console.log(await listConfiguredProviders());
    process.exit(0);
  });

// `aico provider` with no subcommand → show list then offer to add
providerCmd.action(async () => {
  await loadSettings();
  console.log(await listConfiguredProviders());
  process.exit(0);
});

async function runSingleTask(
  task: string,
  opts: CLIOptions,
  settings: Awaited<ReturnType<typeof loadSettings>>,
): Promise<void> {
  const model = opts.model || settings.model || defaultModel();
  const effortHint = buildEffortHint(opts.effort);
  const sessionId = generateSessionId();
  setWorkspaceRuntime({ settings, sessionId });
  setNotificationHookSettings(settings);
  await ensureWorkspace({ settings, sessionId }).catch(() => undefined);

  // Validate provider is reachable before starting
  try {
    selectProvider(model, settings);
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Even a one-shot run gets a durable log: it is what makes `--continue`
  // resume with real tool history rather than a flattened summary.
  const opened = await openSession(sessionId, process.cwd(), opts.name).catch(() => undefined);

  try {
    const result = await runAgent({
      task: task + effortHint,
      model,
      filePath: opts.file,
      showPlan: opts.plan,
      autoApprove: opts.yes || (settings.autoApprove ?? false),
      verbose: opts.verbose,
      conversationHistory: [],
      sessionId,
      settings,
      effort: opts.effort,
      silent: !opts.verbose,
      ...(opened ? { session: opened.session } : {}),
    });
    if (result) process.stdout.write(result + '\n');
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    await opened?.close().catch(() => undefined);
    process.exit(1);
  }
  await opened?.close().catch(() => undefined);
}

async function startREPL(
  opts: CLIOptions,
  settings: Awaited<ReturnType<typeof loadSettings>>,
): Promise<void> {
  resetPermissions();
  freezeHooks(settings);
  setNotificationHookSettings(settings);

  const currentModel = opts.model || settings.model || defaultModel();
  const cwd = process.cwd();

  // ── Validate provider early ────────────────────────────────────────
  try {
    selectProvider(currentModel, settings);
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // ── Feature singletons initialization ─────────────────────────────
  await initializeFeatures({
    settings,
    model: currentModel,
    autoApprove: opts.yes || (settings.autoApprove ?? false),
    verbose: opts.verbose,
  });

  process.on('exit', shutdownFeatures);

  let sessionId = generateSessionId();
  let resumedHistory: Array<{ role: string; content: string }> = [];

  // --continue: load the most recent session
  if (opts.continue) {
    try {
      const last = await loadLastSession(cwd);
      if (last) {
        sessionId = last.id;
        resumedHistory = last.messages.map((m) => ({ role: m.role, content: m.content }));
        console.log(chalk.gray(
          `  Resuming session ${chalk.white(sessionId)} ` +
          `(${Math.floor(resumedHistory.length / 2)} previous turns)`,
        ));
      }
    } catch { /* no previous session */ }
  }
  // --resume [id]
  else if (opts.resume !== undefined) {
    const resumeId = typeof opts.resume === 'string' ? opts.resume : undefined;
    if (resumeId) {
      const session = await loadSession(resumeId, cwd);
      if (session) {
        sessionId = session.id;
        resumedHistory = session.messages.map((m) => ({ role: m.role, content: m.content }));
        console.log(chalk.gray(`  Resumed session ${chalk.white(sessionId)} (${Math.floor(resumedHistory.length / 2)} turns)`));
      } else {
        console.log(chalk.yellow(`  Session "${resumeId}" not found — starting a new session.`));
      }
    } else {
      const sessions = await listSessions(cwd);
      if (sessions.length === 0) {
        console.log(chalk.gray('  No previous sessions found — starting fresh.'));
      } else {
        console.log(chalk.cyan('\n  Recent sessions for this project:\n'));
        sessions.slice(0, 10).forEach((s, i) => {
          const date = new Date(s.startedAt).toLocaleString();
          const shortModel = s.model.replace('claude-', '').replace('gpt-', 'gpt/');
          console.log(
            chalk.gray(`  [${i + 1}] `) + chalk.white(s.id) +
            chalk.gray(`  ${date}  ${shortModel}  (${s.messageCount} msgs)`),
          );
        });
        const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
        const choice = await new Promise<string>((resolve) => {
          rl2.question(chalk.cyan('\n  Enter session number or ID (Enter to start fresh): '), resolve);
        });
        rl2.close();
        const trimmedChoice = choice.trim();
        if (trimmedChoice) {
          const idx = parseInt(trimmedChoice, 10) - 1;
          const selectedId = !isNaN(idx) && idx >= 0 && idx < sessions.length
            ? sessions[idx].id : trimmedChoice;
          const session = await loadSession(selectedId, cwd);
          if (session) {
            sessionId = session.id;
            resumedHistory = session.messages.map((m) => ({ role: m.role, content: m.content }));
            console.log(chalk.gray(`  Resumed session ${chalk.white(sessionId)} (${Math.floor(resumedHistory.length / 2)} turns)`));
          } else {
            console.log(chalk.yellow(`  Session not found — starting a new session.`));
          }
        }
        console.log('');
      }
    }
  }

  await saveSession({ id: sessionId, cwd, model: currentModel, startedAt: Date.now(), messages: [], name: opts.name });
  setWorkspaceRuntime({ settings, sessionId, cwd });
  await ensureWorkspace({ settings, sessionId, cwd }).catch((err: unknown) => {
    console.warn(`  ⚠ Workspace failed to initialize: ${err}`);
  });

  process.stdin.setMaxListeners(50);
  process.stdout.setMaxListeners(50);

  // ── Durable session log ────────────────────────────────────────────
  // Opened once for the whole REPL. Every request is derived from it, so tool
  // calls and results survive across turns and the prompt prefix stays
  // append-only (which is what makes provider prompt caching actually hit).
  // A session resumed from the legacy transcript format is seeded once so
  // --continue does not start the model with an empty context.
  const opened = await openSession(sessionId, cwd, opts.name).catch(() => undefined);
  if (opened && !opened.resumed && resumedHistory.length > 0) {
    seedFromLegacyHistory(opened.session, resumedHistory);
  }
  if (opened) {
    process.on('exit', () => { void opened.close(); });
  }

  // Durable input queue. Replays from the log, so anything the user typed
  // before a crash is still owed when the session is resumed.
  const inbox = opened ? new Inbox(opened.session) : undefined;
  if (inbox?.hasPending) {
    console.log(chalk.gray(
      `  Resuming with ${inbox.nextStep.length + inbox.nextTurn.length} pending message(s) from the previous session.`,
    ));
  }

  if (process.stdout.isTTY && process.stdin.isTTY) {
    try {
      const { startInkRepl } = await import('./ui/App.js');
      await startInkRepl({
        model: currentModel,
        autoApprove: opts.yes || (settings.autoApprove ?? false),
        verbose: opts.verbose,
        sessionId,
        filePath: opts.file,
        showPlan: opts.plan,
        settings,
        cwd,
        resumedHistory,
        sessionName: opts.name,
        effort: opts.effort ?? 'medium',
        ...(opened ? { session: opened.session } : {}),
        ...(inbox ? { inbox } : {}),
      });
      return;
    } catch {
      // fall through to readline fallback
    }
  }

  await startReadlineREPL(
    opts, settings, currentModel, sessionId, cwd, resumedHistory, opened?.session, inbox,
  );
}

async function startReadlineREPL(
  opts: CLIOptions,
  settings: Awaited<ReturnType<typeof loadSettings>>,
  initialModel: string,
  sessionId: string,
  cwd: string,
  resumedHistory: Array<{ role: string; content: string }>,
  session?: import('./session/index.js').Session,
  inbox?: import('./session/index.js').Inbox,
): Promise<void> {
  let currentModel = initialModel;
  let planMode = false;
  const tokenTracker = createTokenTracker();
  const conversationHistory = [...resumedHistory];
  const effortHint = buildEffortHint(opts.effort);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  rl.on('SIGINT', () => {
    console.log('\nGoodbye!');
    rl.close();
    process.exit(0);
  });

  // ── Welcome banner ─────────────────────────────────────────────────
  const shortCwd   = cwd.length > 40 ? '…' + cwd.slice(-37) : cwd;
  const providerName = detectProviderType(currentModel, settings) ?? 'auto';
  const shortModel = currentModel
    .replace('claude-', '')
    .replace('-latest', '')
    .replace('deepseek/', 'ds/')
    .replace('gpt-', 'gpt/');

  console.log('');
  console.log(chalk.yellow('  ✻ ') + chalk.bold('aico') + chalk.gray('  (AI Coder)'));
  console.log('');
  console.log(chalk.gray(`  Provider: `) + chalk.white(providerName));
  console.log(chalk.gray(`  Model:    `) + chalk.white(shortModel));
  console.log(chalk.gray(`  Session:  `) + chalk.white(sessionId));
  console.log(chalk.gray(`  CWD:      `) + chalk.white(shortCwd));
  if (opts.effort && opts.effort !== 'medium') {
    console.log(chalk.gray(`  Effort:   `) + chalk.yellow(opts.effort));
  }
  console.log('');
  console.log(
    chalk.gray('  Type a message, ') + chalk.white('/help') +
    chalk.gray(' for commands, or ') + chalk.white('exit') + chalk.gray(' to quit.'),
  );
  console.log('');
  // After the banner rather than before it: the session is already usable by
  // the time this prints, so a slow disk cannot delay the prompt appearing.
  await announceUpdate();

  const prompt = (): void => {
    rl.question(chalk.green('❯ '), async (input) => {
      const trimmed = input.trim();

      if (!trimmed || /^\u001b\[/.test(trimmed) || /^\[2\d\d~/.test(trimmed)) {
        prompt();
        return;
      }

      if (trimmed === 'exit' || trimmed === 'quit') {
        await runHooks('SessionEnd', { event: 'SessionEnd', exitCode: 0 }, settings).catch(() => {});
        console.log('Goodbye!');
        rl.close();
        process.exit(0);
      }

      if (trimmed.startsWith('/')) {
        const usage = tokenTracker.getUsage();
        const result = await handleSlashCommand(trimmed, {
          conversationHistory,
          currentModel,
          sessionId,
          tokenCount: {
            input: usage.inputTokens,
            output: usage.outputTokens,
            cost: tokenTracker.estimateCost(currentModel),
          },
          setModel: (m) => { currentModel = m; },
          clearHistory: () => { conversationHistory.length = 0; },
          replaceHistory: (msgs: Array<{ role: string; content: string }>) => {
            conversationHistory.length = 0;
            for (const m of msgs) conversationHistory.push(m);
          },
          planMode,
          setPlanMode: (enabled) => { planMode = enabled; },
          settings,
          ...(session ? { session } : {}),
        });
        if (result.handled) {
          if (result.output) console.log('\n' + chalk.white(result.output) + '\n');
          if (result.exit) {
            await runHooks('SessionEnd', { event: 'SessionEnd', exitCode: 0 }, settings).catch(() => {});
            rl.close();
            process.exit(0);
          }
          if (result.sendAsPrompt) {
            rl.pause();
            try {
              const finalMessage = await runAgent({
                task: result.sendAsPrompt,
                model: currentModel,
                showPlan: false,
                autoApprove: opts.yes || (settings.autoApprove ?? false),
                verbose: opts.verbose,
                conversationHistory,
                sessionId,
                tokenTracker,
                settings,
                effort: opts.effort,
                ...(session ? { session } : {}),
              });
              if (finalMessage) {
                conversationHistory.push({ role: 'user',      content: result.sendAsPrompt });
                conversationHistory.push({ role: 'assistant', content: finalMessage });
                maybeAutoCompactConversation(conversationHistory, settings, currentModel, session);
              }
            } catch (err) {
              showError(err instanceof Error ? err.message : String(err));
            }
            rl.resume();
          }
          // Deterministic studio pipeline execution (instead of sendAsPrompt).
          // Runs the Ralph Loop + self-healer + validation stack directly.
          if (result.runStudioPipeline) {
            rl.pause();
            // Give the pipeline its own abort controller so Ctrl+C cancels the
            // long-running build cleanly instead of orphaning sub-agents.
            const studioAbort = new AbortController();
            const onSigInt = () => studioAbort.abort();
            process.once('SIGINT', onSigInt);
            try {
              const state = await readState(result.runStudioPipeline.projectDir);
              if (!state) {
                showError('Studio state not found. Run /studio <requirements> to start a new build.');
              } else {
                const runtime = createStudioRuntime({
                  model: currentModel,
                  autoApprove: opts.yes || (settings.autoApprove ?? false),
                  verbose: opts.verbose,
                  settings,
                  abortSignal: studioAbort.signal,
                });
                const pipelineResult = await runPipeline(state, {
                  runTask: runtime.runTask,
                  askUser: runtime.askUser,
                  abortSignal: studioAbort.signal,
                });
                const summary = pipelineResult.summary || 'Studio pipeline finished.';
                const statusLine = pipelineResult.success
                  ? `\n✅ Studio completed: ${pipelineResult.completedPhases}/${pipelineResult.totalPhases} phases in ${Math.round(pipelineResult.durationMs / 1000)}s.`
                  : `\n⚠️ Studio finished with incomplete phases: ${pipelineResult.completedPhases}/${pipelineResult.totalPhases}.`;
                console.log('\n' + chalk.white(summary) + chalk.gray(statusLine) + '\n');
                conversationHistory.push({ role: 'user', content: `/studio ${state.requirements}` });
                conversationHistory.push({ role: 'assistant', content: summary });
                maybeAutoCompactConversation(conversationHistory, settings, currentModel, session);
              }
            } catch (err) {
              showError(err instanceof Error ? err.message : String(err));
            } finally {
              process.removeListener('SIGINT', onSigInt);
              rl.resume();
            }
          }
          prompt();
          return;
        }
      }

      rl.pause();
      try {
        // Who this conversation is addressed to, read from the log each turn so
        // /agent-mode takes effect on the next message. Without this the
        // command would set state nothing consumed — which is exactly what it
        // used to do.
        const persona = session
          ? await personaFor((await import('./session/projections.js')).currentAgent(session), cwd)
          : {};
        if (persona.notice) console.log(`\n${chalk.yellow(persona.notice)}\n`);

        const finalMessage = await runAgent({
          task: trimmed + effortHint,
          model: persona.model ?? currentModel,
          filePath: opts.file,
          showPlan: opts.plan,
          autoApprove: opts.yes || (settings.autoApprove ?? false),
          verbose: opts.verbose,
          conversationHistory,
          sessionId,
          tokenTracker,
          settings,
          planMode,
          effort: opts.effort,
          ...(session ? { session } : {}),
          ...(inbox ? { inbox } : {}),
          ...(persona.persona ? { agentPersona: persona.persona } : {}),
          ...(persona.tools?.length ? { agentSpecTools: persona.tools } : {}),
        });
        if (finalMessage) {
          conversationHistory.push({ role: 'user',      content: trimmed });
          conversationHistory.push({ role: 'assistant', content: finalMessage });
          maybeAutoCompactConversation(conversationHistory, settings, currentModel, session);
          const now = Date.now();
          await appendMessage(sessionId, cwd, { role: 'user',      content: trimmed,       timestamp: now });
          await appendMessage(sessionId, cwd, { role: 'assistant', content: finalMessage,  timestamp: now + 1 });
        }
      } catch (err) {
        showError(err instanceof Error ? err.message : String(err));
      }

      const usage = tokenTracker.getUsage();
      if (usage.inputTokens > 0 || usage.outputTokens > 0) {
        process.stdout.write(
          chalk.gray(`\n[${tokenTracker.format(currentModel)} | ~$${tokenTracker.estimateCost(currentModel).toFixed(4)}]\n`),
        );
      }
      process.stdout.write('\n');
      rl.resume();
      prompt();
    });
  };

  prompt();
}

program.parseAsync(process.argv).catch((err) => {
  showError(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
