/**
 * The non-conversational half of the web API: settings, provider onboarding,
 * and the live state of everything running outside the current turn.
 *
 * These are split from `server/index.ts` because they answer a different
 * question. The routes there are about *this turn* — submit, stream, cancel.
 * These are about *the installation* — which providers are usable, what
 * background work is in flight, which scheduled jobs exist. A client polls
 * these; it subscribes to the others.
 *
 * ## On returning keys
 *
 * No route here ever returns an API key, not even the one just submitted for
 * testing. A settings page needs to show *whether* a provider is configured and
 * *where* the key came from, which is what `configured` and `source` carry. It
 * never needs the secret back, and a JSON response is the easiest place in the
 * system for one to end up somewhere it should not be.
 *
 * @module server/api-system
 */

import { getBackgroundAgents, cancelBackgroundAgent } from '../background/index.js';
import { worktreeManager } from '../worktree/index.js';
import { skillRegistry } from '../skills/index.js';
import { mcpRegistry } from '../mcp/registry.js';
import { ledger } from '../work/ledger.js';
import { isTerminal as isTerminalWork } from '../work/types.js';
import { stopWork } from '../work/handles.js';
import { disabledIn } from '../registry-state.js';
import { executeCronList, executeCronDelete, executeCronPause, executeCronResume } from '../cron/tools.js';
import { testProvider, testInstance } from '../providers/connection-test.js';
import {
  PROVIDER_TYPES, PROVIDER_TYPE_IDS, listInstances, normalize,
  redactInstance, validateInstance,
} from '../providers/instances.js';
import type { ProviderInstance } from '../providers/instances.js';
import { loadSettings, patchUserProviderTuning, patchUserSettingPath, saveUserSetting } from '../settings.js';
import { FAMILY_REASONING, tuningChoice, tuningPatch, type FamilyDefault } from '../../shared/reasoning.js';
import { getModelCapabilities, recordCatalogueModalities } from '../model-capabilities.js';
import type { ModelCapabilities } from '../model-capabilities.js';
import { getWorkspaceInfo } from '../workspace.js';
import type { AicoSettings } from '../settings.js';

/** The environment variable each provider reads when no key is in settings. */
const ENV_KEYS: Record<string, string> = {
  openrouter: 'OPENROUTER_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  zai: 'ZAI_API_KEY',
  ollama: '',
};

/** Everything the System panel shows, in one round trip. */
export async function systemSnapshot(): Promise<Record<string, unknown>> {
  const settings = await loadSettings();
  const disabledMcp = disabledIn('mcp');
  return {
    backgroundAgents: getBackgroundAgents().map(a => ({
      agentId: a.agentId,
      description: a.description,
      model: a.model,
      status: a.status,
      statusMessage: a.statusMessage,
      startedAt: a.startedAt,
      completedAt: a.completedAt,
      toolCallCount: a.toolCallCount,
      currentTool: a.currentTool,
      // The full result can be a whole essay; the panel lists, it does not read.
      resultPreview: a.result ? a.result.slice(0, 400) : undefined,
      error: a.error,
    })),
    cron: executeCronList(),
    /*
      Everything the ledger holds: sub-agents, background agents, scheduled
      firings, backgrounded processes, Mini App servers and watchers.

      Live work plus recently settled work, because "what failed while I was
      away?" is the question the panel exists to answer and a list of only
      what is running now cannot answer it. Bounded so a long-lived install
      does not ship its whole history on every poll.
    */
    work: [
      ...ledger.query({ live: true }),
      ...ledger.all()
        .filter(r => isTerminalWork(r.state))
        .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))
        .slice(0, 30),
    ].map(r => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      state: r.state,
      origin: r.origin,
      parent: r.parent,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      heartbeatAt: r.heartbeatAt,
      steps: r.progress?.steps,
      lastTool: r.progress?.lastTool,
      note: r.progress?.note,
      costUsd: r.cost?.usd,
      pid: r.pid,
      reported: r.reported,
      // The panel lists; it does not read. A whole essay of a result would
      // make every other row unreachable.
      outcome: (r.error ?? r.result)?.slice(0, 300),
    })),
    worktrees: worktreeManager.getAll(),
    skills: skillRegistry.list().map(s => ({
      name: s.frontmatter.name,
      description: s.frontmatter.description,
      builtin: s.isBuiltin,
    })),
    // Names alone said nothing about whether a server was doing anything. A
    // server contributing zero tools is the commonest way this is
    // misconfigured, and the panel is where someone would look.
    mcpServers: [
      ...Object.keys(settings.mcpServers ?? {}).map(name => {
        const info = mcpRegistry.getServerInfos().find(s => s.name === name);
        return {
          name,
          enabled: !disabledMcp.has(name.toLowerCase()),
          health: info?.health ?? 'not loaded',
          toolCount: info?.toolCount ?? 0,
          resourceCount: info?.resourceCount ?? 0,
        };
      }),
      // Servers the host process contributed for this run (the desktop app's
      // IDE and browser tools). Not in settings, so listed from the registry.
      ...mcpRegistry.getServerInfos().filter(s => s.host && !(s.name in (settings.mcpServers ?? {}))).map(s => ({
        name: s.name,
        enabled: true,
        health: s.health,
        toolCount: s.toolCount,
        resourceCount: s.resourceCount,
        host: true,
      })),
    ],
    workspace: describeWorkspace(settings),
  };
}

/**
 * Where the agent writes things that are not part of your project.
 *
 * Surfaced because it was invisible: files appeared somewhere on disk with no
 * indication where, and the only way to find out was to ask the agent.
 */
function describeWorkspace(settings: AicoSettings): {
  root: string; configured: boolean; sessionDir?: string;
} {
  const info = getWorkspaceInfo({ settings });
  return {
    root: info.root,
    configured: Boolean(settings.workspace?.path),
    ...(info.sessionDir ? { sessionDir: info.sessionDir } : {}),
  };
}

/**
 * Handle a `/api/system/*` or provider/settings route.
 *
 * Returns the JSON body to send, or `undefined` when the route is not ours —
 * which lets the caller fall through to its own 404 rather than this module
 * having to know what else exists.
 */
export async function handleSystemRoute(
  route: string,
  method: string,
  body: Record<string, unknown>,
  /**
   * The request's query string.
   *
   * A GET carries its arguments here rather than in a body, and without this a
   * read like `skills/read?name=commit` had no way to learn which skill was
   * being asked for.
   */
  query: URLSearchParams = new URLSearchParams(),
  /**
   * Whether a person is behind this request (server/decision-gate
   * `checkHuman`): a desktop host grant, the web UI key, or its live client
   * nonce. Asked only by the few actions the token alone may not take —
   * enabling an imported skill (design §5.1). Absent means "no".
   */
  human: () => Promise<{ ok: boolean; reason?: string }> = async () => ({ ok: false, reason: 'no person attached to this request' }),
): Promise<{ status: number; body: unknown } | undefined> {
  /** 403 with the gate's reason, in the shape the clients already read. */
  const needsHuman = (reason?: string): { status: number; body: unknown } => ({
    status: 403, body: { ok: false, code: 'human-required', error: reason ?? 'This needs a person in the AICO window.' },
  });
  // The morning brief and monitors (brief/service): reads, a manual run, monitor switches.
  if (route.startsWith('brief/')) {
    const { handleBriefRoute } = await import('../brief/service.js');
    return handleBriefRoute(route, method, body, query);
  }
  // About you (profile/service, ADR 0018): facts, their controls, a run, export, wipe.
  if (route === 'profile' || route.startsWith('profile/')) {
    const { handleProfileRoute } = await import('../profile/service.js');
    return handleProfileRoute(route, method, body, human);
  }
  // Recall (ADR 0018): search past sessions, memories, knowledge, About you; rebuild the index.
  if (route.startsWith('recall/')) {
    const { handleRecallRoute } = await import('../recall/index.js');
    return handleRecallRoute(route, method, query, process.cwd());
  }
  switch (route) {
    // ── the approve-later inbox (Phase 7, autonomy/inbox.ts) ─────────
    //
    // Calls an unattended (L4) run parked for a person. Listing is a read.
    // Approving runs the exact parked call once, so it needs a person
    // (`checkHuman`): the desktop window's grant, the web UI key or a live
    // client nonce — never the API token alone, which the model may hold.
    // Denying needs nothing: refusing is always safe.
    case 'inbox/list': {
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
      const { listActions } = await import('../autonomy/inbox.js');
      const status = query.get('status') === 'pending' ? 'pending' : 'all';
      const actions = listActions({ status, limit: Number(query.get('limit')) || 100 });
      return { status: 200, body: { actions, pending: actions.filter(a => a.status === 'pending').length } };
    }
    case 'inbox/decide': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const id = typeof body.id === 'string' ? body.id : '';
      const decision = body.decision;
      if (!id || (decision !== 'approve' && decision !== 'deny')) return { status: 400, body: { error: 'id and decision ("approve" or "deny") required' } };
      const inbox = await import('../autonomy/inbox.js');
      if (decision === 'deny') {
        const r = inbox.denyAction(id, 'api', typeof body.note === 'string' ? body.note : undefined);
        return { status: r.action ? 200 : 404, body: r };
      }
      const person = await human();
      if (!person.ok) return needsHuman(person.reason);
      const r = await inbox.approveAction(id, (person as { via?: string }).via ?? 'person');
      return { status: r.action ? 200 : 404, body: r };
    }
    // ── the Sentinel's recent verdicts (sentinel/, ADR 0015) ─────────
    // A read of the audit file: arguments are already redacted there.
    case 'sentinel/list': {
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
      const { listSentinelVerdicts } = await import('../sentinel/index.js');
      return { status: 200, body: listSentinelVerdicts(Math.min(200, Number(query.get('limit')) || 50)) };
    }
    // ── long jobs (longjob/) ─────────────────────────────────────────
    //
    // A proposal for work estimated above the long-job threshold. Approving
    // starts paid work that runs across turns, and resuming restarts it, so
    // both need a person (`checkHuman`) — never the API token alone, which
    // the model may hold. Declining, pausing and stopping need nothing.
    case 'longjob/list': {
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
      const { listJobs } = await import('../longjob/index.js');
      const sessionId = query.get('sessionId') || undefined;
      return { status: 200, body: { jobs: listJobs(sessionId ? { sessionId } : {}).slice(0, 50) } };
    }
    case 'longjob/decide':
    case 'longjob/control': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const id = typeof body.id === 'string' ? body.id : '';
      const what = route === 'longjob/decide' ? body.decision : body.action;
      const allowed = route === 'longjob/decide' ? ['approve', 'decline'] : ['pause', 'resume', 'stop'];
      if (!id || typeof what !== 'string' || !allowed.includes(what)) {
        return { status: 400, body: { error: `id and ${route === 'longjob/decide' ? 'decision' : 'action'} (${allowed.join(', ')}) required` } };
      }
      let via = 'api';
      if (what === 'approve' || what === 'resume') {
        const person = await human();
        if (!person.ok) return needsHuman(person.reason);
        via = (person as { via?: string }).via ?? 'person';
      }
      const longjob = await import('../longjob/index.js');
      const r = route === 'longjob/decide'
        ? longjob.decide(id, what as 'approve' | 'decline', via)
        : longjob.control(id, what as 'pause' | 'resume' | 'stop', via);
      return { status: r.job ? (r.ok ? 200 : 409) : 404, body: r };
    }
    // ── project profile ──────────────────────────────────────────────
    //
    // The commands a project is held to, with provenance, for the System
    // screen's Commands table. A GET reads `?cwd=`; a POST sets one command
    // (`{ cwd, name, command }`) at `user` rank — a person's word — or forgets
    // one (`{ cwd, name, forget: true }`). The model never reaches this route:
    // it corrects a command by running the right one, which the observer records.
    // ── learning ─────────────────────────────────────────────────────
    //
    // Proposals the log produced, waiting for a person. `list` reads a
    // project's (and the global) open ones; `adopt` writes what a proposal
    // says — with the person's edits — and marks it; `dismiss` marks it so the
    // same lesson is not proposed again. The model never reaches these.
    case 'learning/list': {
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
      const { listProposals } = await import('../learning/proposals.js');
      const { default: path } = await import('path');
      const cwd = path.resolve(query.get('cwd') || process.cwd());
      const status = (query.get('status') ?? 'open') as 'open' | 'adopted' | 'dismissed' | 'all';
      const wanted = status === 'all' ? undefined : status;
      return {
        status: 200,
        body: {
          cwd,
          project: listProposals(cwd, wanted),
          global: listProposals('global', wanted),
        },
      };
    }
    case 'learning/adopt': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const { adoptProposal } = await import('../learning/proposals.js');
      const { default: path } = await import('path');
      const cwd = path.resolve(typeof body.cwd === 'string' && body.cwd ? body.cwd : process.cwd());
      const id = String(body.id ?? '');
      if (!id) return { status: 400, body: { error: 'id required' } };
      const edits = {
        ...(typeof body.trigger === 'string' ? { trigger: body.trigger } : {}),
        ...(typeof body.content === 'string' ? { content: body.content } : {}),
        ...(body.scope === 'global' || body.scope === 'project' ? { scope: body.scope as 'global' | 'project' } : {}),
      };
      const result = await adoptProposal(cwd, id, edits);
      return result.ok ? { status: 200, body: result } : { status: 400, body: { error: result.error } };
    }
    case 'learning/dismiss': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const { setProposalStatus, proposalsFile } = await import('../learning/proposals.js');
      const { default: path } = await import('path');
      const { default: fs } = await import('fs');
      const cwd = path.resolve(typeof body.cwd === 'string' && body.cwd ? body.cwd : process.cwd());
      const id = String(body.id ?? '');
      if (!id) return { status: 400, body: { error: 'id required' } };
      // A global proposal lives in the global file; try the project first.
      const inProject = fs.existsSync(proposalsFile(cwd)) && setProposalStatus(cwd, id, 'dismissed');
      const found = inProject || setProposalStatus('global', id, 'dismissed');
      return found ? { status: 200, body: { ok: true, id } } : { status: 404, body: { error: `no proposal "${id}"` } };
    }
    // ── what AICO learned about how you work (ADR 0016) ──────────────
    //
    // Preference rules: `preferences` lists them (all scopes; the page shows
    // which apply to `?cwd=`) and the pending-signal count; `preferences/act`
    // changes one. Putting a rule in force — accept, enable, edit, add —
    // needs a person (`human()`), because an active rule is prompt text the
    // model would otherwise be able to write for itself with the API token.
    // Disable and forget need nothing: switching a rule off is always safe.
    case 'learning/preferences': {
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
      const { listRules, selectRules } = await import('../learning/preferences.js');
      const { readPendingSignals } = await import('../learning/signals.js');
      const { default: path } = await import('path');
      const cwd = path.resolve(query.get('cwd') || process.cwd());
      const rules = listRules();
      const applying = selectRules(rules, { projectRoot: cwd, task: '' }).map(r => r.id);
      return { status: 200, body: { cwd, rules, applying, pending: readPendingSignals().length } };
    }
    case 'learning/preferences/act': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const P = await import('../learning/preferences.js');
      const action = String(body.action ?? '');
      const id = typeof body.id === 'string' ? body.id : '';
      const text = typeof body.text === 'string' ? body.text : undefined;
      const rawScope = typeof body.scope === 'string' ? body.scope : undefined;
      // A scope of "project" means the project the page is showing.
      const { default: path } = await import('path');
      const scope = rawScope === 'project' ? `project:${path.resolve(typeof body.cwd === 'string' && body.cwd ? body.cwd : process.cwd())}` : rawScope;
      let act: import('../learning/preferences.js').RuleAction;
      if (action === 'add') {
        if (!text) return { status: 400, body: { error: 'text required' } };
        act = { action: 'add', text, ...(scope ? { scope } : {}), ...(body.category === 'style' || body.category === 'tooling' || body.category === 'communication' ? { category: body.category } : {}) };
      } else if (action === 'edit') {
        if (!id) return { status: 400, body: { error: 'id required' } };
        act = { action: 'edit', id, ...(text !== undefined ? { text } : {}), ...(scope ? { scope } : {}) };
      } else if (action === 'accept' || action === 'enable' || action === 'disable' || action === 'forget') {
        if (!id) return { status: 400, body: { error: 'id required' } };
        act = { action, id };
      } else {
        return { status: 400, body: { error: 'action must be accept, enable, disable, forget, edit or add' } };
      }
      if (action === 'accept' || action === 'enable' || action === 'edit' || action === 'add') {
        const verdict = await human();
        if (!verdict.ok) return needsHuman(verdict.reason);
      }
      const store = P.loadStore();
      const result = P.applyRuleAction(store, act);
      if (!result.ok) return { status: 400, body: { error: result.error } };
      P.saveStore(store);
      return { status: 200, body: result };
    }
    case 'learning/preferences/export': {
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
      const { listRules } = await import('../learning/preferences.js');
      return { status: 200, body: { exportedAt: new Date().toISOString(), format: 'aico-preferences/1', rules: listRules() } };
    }

    // ── sub-agent economy ────────────────────────────────────────────
    case 'agents/recommendation': {
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
      const { recommendedAgentModels, CHEAP_ROLES } = await import('../agents/economy.js');
      const { loadSettings } = await import('../settings.js');
      const settings = await loadSettings();
      const model = query.get('model') || settings.model || '';
      return { status: 200, body: { ...recommendedAgentModels(model, settings), roles: CHEAP_ROLES } };
    }

    // ── model roles (models/roles, ADR 0017) ─────────────────────────
    //
    // Which model does which job, where it is served, what it costs and why
    // it is what it is. A read: choices are written through `settings/path`
    // (`models.*`), the user's own file only — a project's files cannot set
    // them. Model ids, prices and provider names only; never a key.
    case 'models/roles': {
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
      const settings = await loadSettings();
      const { resolveAllRoles, ROLES, rolePrice, roleSpend } = await import('../models/roles.js');
      const { PROVIDER_DEFAULT_MODELS } = await import('../providers/index.js');
      const { CHEAP_MODELS } = await import('../../shared/models.js');
      const mainModel = query.get('model') || settings.model
        || PROVIDER_DEFAULT_MODELS[settings.activeProvider ?? settings.provider ?? 'openrouter'] || '';
      const instances = listInstances(settings);
      const spend = roleSpend();
      const roles = resolveAllRoles({ settings, mainModel }).map((r) => {
        const info = ROLES.find(i => i.role === r.role)!;
        const instance = r.instanceId ? instances.find(i => i.id === r.instanceId) : undefined;
        return {
          ...r,
          label: info.label, does: info.does, personal: info.personal, needs: info.needs,
          provider: instance?.name ?? r.providerType ?? null,
          price: r.model ? rolePrice(r.model, settings) : null,
          chosen: settings.models?.roles?.[r.role] ?? null,
          spent: spend[r.role] ?? null,
        };
      });
      // What the picker offers: every model a provider has listed, the cheap
      // model of each family, and the work model. Free text is accepted too.
      const suggestions = [...new Set([
        mainModel,
        ...instances.flatMap(i => [i.defaultModel, ...(i.models ?? [])]),
        ...Object.values(CHEAP_MODELS),
      ].filter((m): m is string => typeof m === 'string' && m.length > 0))].slice(0, 500);
      return {
        status: 200,
        body: {
          mainModel,
          preset: settings.models?.preset ?? 'balanced',
          localOnlyPersonal: settings.models?.localOnlyPersonal === true,
          roles,
          suggestions,
        },
      };
    }

    case 'project/profile': {
      const { loadProfile, forgetCommand, saveProfile, COMMAND_NAMES, checksFor } = await import('../project/profile.js');
      const { default: path } = await import('path');
      const cwdRaw = method === 'GET' ? query.get('cwd') : typeof body.cwd === 'string' ? body.cwd : undefined;
      const cwd = path.resolve(cwdRaw || process.cwd());
      if (method === 'GET') {
        // Reading bootstraps the file from the manifest, so the table is never
        // empty for a project that plainly has a package.json.
        checksFor(cwd);
        return { status: 200, body: { cwd, profile: loadProfile(cwd), names: COMMAND_NAMES } };
      }
      if (method !== 'POST') return { status: 405, body: { error: 'GET or POST' } };
      const name = String(body.name ?? '');
      if (!(COMMAND_NAMES as readonly string[]).includes(name)) return { status: 400, body: { error: `name must be one of ${COMMAND_NAMES.join(', ')}` } };
      if (body.forget === true) {
        const next = forgetCommand(loadProfile(cwd), name as typeof COMMAND_NAMES[number]);
        await saveProfile(cwd, next);
        return { status: 200, body: { cwd, profile: next } };
      }
      const command = String(body.command ?? '').trim();
      if (!command) return { status: 400, body: { error: 'command required' } };
      // A person's edit is `user` rank: nothing observed or detected can undo it.
      // Written directly rather than merged so a user can also *replace* their
      // own earlier entry.
      const current = loadProfile(cwd);
      const next = { ...current, commands: { ...current.commands, [name]: { command, source: 'user' as const, at: new Date().toISOString() } } };
      await saveProfile(cwd, next);
      return { status: 200, body: { cwd, profile: next } };
    }

    // ── workspace page ────────────────────────────────────────────────
    //
    // The two pieces of a workspace's history that no session-scoped route
    // answers: its commit log (`changes.ts` only diffs the working tree
    // against HEAD) and totals across every session it has ever had (cost
    // and usage otherwise live only on a currently-open session's tracker).
    case 'project/git-log': {
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
      const { gitLog } = await import('./changes.js');
      const { default: path } = await import('path');
      const cwd = path.resolve(query.get('path') || process.cwd());
      const limit = Number(query.get('limit') ?? '30') || 30;
      const before = query.get('before') || undefined;
      const page = await gitLog(cwd, { limit, ...(before ? { before } : {}) });
      return { status: 200, body: { cwd, ...page } };
    }

    /*
      Git beyond the log: a commit's changes, the branches, and the three
      moves the workspace page offers (switch, branch from a commit, revert).
      Only for a directory that is actually a workspace — this is not a
      general "run git anywhere" door. See git-ops.ts for what each refuses.
    */
    case 'project/git-show':
    case 'project/git-branches':
    case 'project/git-status':
    case 'project/git-diff':
    case 'project/git-stashes':
    case 'project/git-action': {
      const { default: path } = await import('path');
      const { isKnownProject } = await import('./projects.js');
      const ops = await import('./git-ops.js');
      const raw = route === 'project/git-action' ? (body.path as string | undefined) : query.get('path');
      if (!raw) return { status: 400, body: { error: 'path required' } };
      const cwd = path.resolve(raw);
      if (!await isKnownProject(process.cwd(), cwd)) return { status: 403, body: { error: 'not a workspace' } };
      try {
        if (route === 'project/git-show') {
          if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
          return { status: 200, body: await ops.showCommit(cwd, query.get('hash') ?? '') };
        }
        if (route === 'project/git-branches') {
          if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
          return { status: 200, body: await ops.listBranches(cwd) };
        }
        if (route === 'project/git-status') {
          if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
          return { status: 200, body: await ops.gitStatus(cwd) };
        }
        if (route === 'project/git-diff') {
          if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
          return { status: 200, body: await ops.fileDiff(cwd, query.get('file') ?? '', query.get('staged') === '1') };
        }
        if (route === 'project/git-stashes') {
          if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
          return { status: 200, body: { stashes: await ops.stashList(cwd) } };
        }
        if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
        const { action, name, at, switchTo, paths, message, all, includeUntracked, ref } = body as {
          action?: string; name?: string; at?: string; switchTo?: boolean;
          paths?: string[] | 'all'; message?: string; all?: boolean; includeUntracked?: boolean; ref?: string;
        };
        let detail: unknown;
        switch (action) {
          case 'switch': await ops.switchBranch(cwd, String(name ?? '')); break;
          case 'branch': await ops.createBranch(cwd, String(name ?? ''), String(at ?? ''), switchTo === true); break;
          case 'revert': await ops.revertCommit(cwd, String(at ?? '')); break;
          case 'new-branch': await ops.newBranchHere(cwd, String(name ?? '')); break;
          case 'delete-branch': await ops.deleteBranch(cwd, String(name ?? '')); break;
          case 'stage': await ops.stage(cwd, paths === 'all' ? 'all' : (paths ?? [])); break;
          case 'unstage': await ops.unstage(cwd, paths === 'all' ? 'all' : (paths ?? [])); break;
          case 'discard': await ops.discard(cwd, Array.isArray(paths) ? paths : []); break;
          case 'commit': detail = await ops.commit(cwd, String(message ?? ''), { all: all === true }); break;
          case 'push': detail = await ops.push(cwd); break;
          case 'pull': detail = await ops.pull(cwd); break;
          case 'fetch': detail = await ops.fetchAll(cwd); break;
          case 'stash': await ops.stashPush(cwd, String(message ?? ''), includeUntracked === true); break;
          case 'stash-pop': await ops.stashPop(cwd, String(ref ?? '')); break;
          case 'init': await ops.initRepo(cwd); break;
          default:
            return { status: 400, body: { error: 'unknown git action' } };
        }
        return { status: 200, body: { ok: true, detail, ...(await ops.listBranches(cwd).catch(() => ({ current: null, branches: [] }))), status: await ops.gitStatus(cwd) } };
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } };
      }
    }

    case 'project/stats': {
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
      const { projectStats } = await import('../project/stats.js');
      const { default: path } = await import('path');
      const cwd = path.resolve(query.get('path') || process.cwd());
      const { loadSettings: loadCurrentSettings } = await import('../settings.js');
      const settings = await loadCurrentSettings();
      const stats = await projectStats(cwd, settings);
      return { status: 200, body: { cwd, ...stats } };
    }

    case 'agents': {
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
      const { listAgentSpecs } = await import('../agents/registry.js');
      const { disabledIn: disabledAgents } = await import('../registry-state.js');
      const specs = await listAgentSpecs();
      const offAgents = disabledAgents('agents');
      // Certification status on every row (design §6.4), against the model the
      // agent would run on here. A failure to read it is "uncertified", never an error.
      const { statusOfSpec } = await import('../evals/certificate.js');
      const { loadSettings: loadForStatus } = await import('../settings.js');
      const defaultModel = (await loadForStatus().catch(() => undefined))?.model ?? '';
      const certification = new Map(await Promise.all(specs.map(async spec => [spec.name,
        await statusOfSpec(spec, { cwd: process.cwd(), model: spec.model || defaultModel })
          .then(s => ({ status: s.status, text: s.text, ...(s.certificate ? { at: s.certificate.at } : {}) }))
          .catch(() => ({ status: 'uncertified' as const, text: 'not certified' }))] as const)));
      return {
        status: 200,
        body: {
          // The full prompt is deliberately not returned: it is thousands of
          // tokens per agent, the panel lists rather than reads, and nothing in
          // the browser has a use for it.
          agents: specs.map(spec => ({
            certification: certification.get(spec.name),
            name: spec.name,
            description: spec.description,
            role: spec.role,
            goals: spec.goals,
            skills: spec.skills,
            tools: spec.tools,
            canDelegate: spec.canDelegate,
            source: spec.source,
            enabled: !offAgents.has(spec.name.toLowerCase()),
            model: spec.model,
            // Phase 3 fields, for the builders. The instructions are the
            // person's own text (not the generated prompt), so they are sent.
            ...(spec.instructions ? { instructions: spec.instructions } : {}),
            ...(spec.disallowedTools ? { disallowedTools: spec.disallowedTools } : {}),
            ...(spec.mcpServers ? { mcpServers: spec.mcpServers } : {}),
            ...(spec.delegate ? { delegate: spec.delegate } : {}),
            ...(spec.autonomy ? { autonomy: spec.autonomy } : {}),
            ...(spec.budget ? { budget: spec.budget } : {}),
            ...(spec.paths ? { paths: spec.paths } : {}),
            ...(spec.format ? { format: spec.format } : {}),
            ...(spec.warnings?.length ? { warnings: spec.warnings } : {}),
          })),
        },
      };
    }

    // ── skills ───────────────────────────────────────────────────────
    //
    // A skill is a procedure someone wrote down, and the point of having one is
    // that the agent uses it. So the list carries the same description the
    // model selects on, and importing accepts what people actually have: a
    // folder, a zip, or a bare SKILL.md.
    case 'skills': {
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
      const { skillRegistry } = await import('../skills/registry.js');
      const { disabledIn } = await import('../registry-state.js');
      await skillRegistry.load({});
      await skillRegistry.ensureProject().catch(() => undefined);
      const offSkills = disabledIn('skills');
      return {
        status: 200,
        body: {
          // Every installed skill, unreviewed ones included: this is where a
          // person finds them to review.
          skills: skillRegistry.listAll().map(s => ({
            name: s.frontmatter.name,
            description: s.frontmatter.description,
            builtin: s.isBuiltin,
            // An unreviewed skill is never "enabled", whatever its switch says.
            enabled: s.trust !== 'unreviewed' && !offSkills.has(s.frontmatter.name.toLowerCase()),
            trust: s.trust ?? 'authored',
            ...(s.trustReason ? { trustReason: s.trustReason } : {}),
            ...(s.provenance ? { provenance: s.provenance } : {}),
            warnings: s.warnings ?? [],
            compatibility: s.frontmatter.compatibility,
            trigger: s.frontmatter.trigger,
            aliases: s.frontmatter.aliases ?? [],
            allowedTools: s.frontmatter.allowedTools ?? [],
            license: s.frontmatter.license,
            version: s.frontmatter.version,
            author: s.frontmatter.author,
            resources: s.resources ?? [],
            path: s.dir ?? s.filePath,
          })),
        },
      };
    }

    // ── measuring a skill ────────────────────────────────────────────
    //
    // Long-running and paid for, so these are jobs: start returns an id, the
    // client polls, and a run outlives the tab that started it. See
    // `skills/eval/jobs`.
    case 'skill-eval/tasks': {
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
      const name = String(query.get('name') ?? body.name ?? '');
      if (!name) return { status: 400, body: { error: 'name required' } };
      const { describeCorpus } = await import('../skills/eval/jobs.js');
      return { status: 200, body: await describeCorpus(name) };
    }
    case 'skill-eval/run':
    case 'skill-eval/optimize': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const { startEval, startOptimize } = await import('../skills/eval/jobs.js');
      const { loadSettings } = await import('../settings.js');
      const settings = await loadSettings();
      const skill = String(body.skill ?? '');
      const model = String(body.model ?? settings.model ?? '');
      if (!skill) return { status: 400, body: { error: 'skill required' } };
      if (!model) return { status: 400, body: { error: 'model required — none configured' } };
      /*
        The ceiling is the client's number, clamped rather than trusted. A
        typo of 100 where 1.00 was meant is the difference between a coffee
        and a phone bill, and the field is a text box.
      */
      const budgetUsd = Math.min(Math.max(Number(body.budgetUsd ?? 1), 0), 25);
      const common = {
        skill, model, settings, budgetUsd,
        ...(typeof body.maxIterations === 'number' ? { maxIterations: body.maxIterations } : {}),
      };
      const started = route === 'skill-eval/run'
        ? await startEval(common)
        : await startOptimize({
          ...common,
          steps: Math.min(Math.max(Number(body.steps ?? 3), 1), 10),
          candidates: Math.min(Math.max(Number(body.candidates ?? 1), 1), 4),
          ...(typeof body.maxEdits === 'number' ? { maxEdits: body.maxEdits } : {}),
          ...(typeof body.optimizerModel === 'string' && body.optimizerModel ? { optimizerModel: body.optimizerModel } : {}),
        });
      if ('error' in started) return { status: 400, body: started };
      return { status: 200, body: started };
    }
    case 'skill-eval/job': {
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
      const { getJob } = await import('../skills/eval/jobs.js');
      const job = getJob(String(query.get('id') ?? ''));
      return job ? { status: 200, body: job } : { status: 404, body: { error: 'no such job' } };
    }
    case 'skill-eval/cancel': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const { cancelJob } = await import('../skills/eval/jobs.js');
      return { status: 200, body: { cancelled: cancelJob(String(body.id ?? '')) } };
    }
    case 'skill-eval/adopt': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const { adoptCandidate } = await import('../skills/eval/jobs.js');
      return { status: 200, body: await adoptCandidate(String(body.id ?? '')) };
    }

    case 'skills/read': {
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
      const name = String(query.get('name') ?? body.name ?? '');
      const { skillRegistry } = await import('../skills/registry.js');
      await skillRegistry.load({});
      // Any installed skill: reading an unreviewed one is how it gets reviewed.
      const found = skillRegistry.lookupAny(name);
      if (!found) return { status: 404, body: { error: `no skill called "${name}"` } };
      return { status: 200, body: { name: found.frontmatter.name, body: found.promptTemplate } };
    }

    // ── importing a skill: review first, then install ───────────────
    //
    // `skills/review` stages an import (a path on this machine, uploaded
    // files, or pasted markdown — or an installed skill by name) and returns
    // the review: every skill found, its files, scripts, scan findings with
    // file and line, validation, provenance. Nothing is installed.
    // `skills/install` installs a staged review. With `enable: true` it needs
    // a person (the decision gate) and installs as reviewed; without, the
    // skills land unreviewed — on disk, out of the catalogue.
    case 'skills/review': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const { stageImport, reviewInstalled } = await import('../skills/import.js');
      if (typeof body.name === 'string' && body.name) {
        const { skillRegistry } = await import('../skills/registry.js');
        await skillRegistry.load({});
        const found = skillRegistry.lookupAny(body.name);
        if (!found?.dir) return { status: 404, body: { error: `no installed directory skill called "${body.name}"` } };
        const r = reviewInstalled(found.dir);
        return { status: 200, body: { installed: true, trust: found.trust ?? 'authored', ...(found.trustReason ? { trustReason: found.trustReason } : {}), skill: r } };
      }
      const label = typeof body.label === 'string' ? body.label : undefined;
      const input = typeof body.source === 'string' && body.source.trim()
        ? { path: body.source.trim(), ...(label ? { label } : {}) }
        : typeof body.markdown === 'string' && body.markdown.trim()
          ? { markdown: body.markdown, ...(label ? { label } : {}) }
          : Array.isArray(body.files) && body.files.length
            ? { files: (body.files as Array<{ path?: unknown; base64?: unknown }>).map(f => ({ path: String(f.path ?? ''), base64: String(f.base64 ?? '') })), ...(label ? { label } : {}) }
            : undefined;
      if (!input) return { status: 400, body: { error: 'Give a source path, files, or markdown to review.' } };
      const review = await stageImport(input);
      return 'error' in review ? { status: 400, body: { ok: false, error: review.error } } : { status: 200, body: { ok: true, review } };
    }

    case 'skills/install': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const id = String(body.id ?? '');
      if (!id) return { status: 400, body: { error: 'id required — from skills/review' } };
      const enable = body.enable === true;
      if (enable) {
        const verdict = await human();
        if (!verdict.ok) return needsHuman(verdict.reason);
      }
      const { installStaged } = await import('../skills/import.js');
      const { setEnabled } = await import('../registry-state.js');
      const out = installStaged(id, {
        trust: enable ? 'reviewed' : 'unreviewed',
        overwrite: body.overwrite === true,
        ...(Array.isArray(body.select) ? { select: (body.select as unknown[]).map(String) } : {}),
      });
      if (enable) for (const sk of out.installed) setEnabled('skills', sk.name, true);
      const { skillRegistry } = await import('../skills/registry.js');
      await skillRegistry.reload();
      return { status: out.error ? 400 : 200, body: out };
    }

    case 'skills/discard': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const { discardStaged } = await import('../skills/import.js');
      return { status: 200, body: { ok: discardStaged(String(body.id ?? '')) } };
    }

    /**
     * A skill as Claude's `.skill` archive. With `dest` (a path the person
     * chose in a save dialog) it is written there; without, the bytes come
     * back as base64 for the browser to download.
     */
    case 'skills/export': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const { skillRegistry } = await import('../skills/registry.js');
      await skillRegistry.load({});
      await skillRegistry.ensureProject().catch(() => undefined);
      const found = skillRegistry.lookupAny(String(body.name ?? ''));
      if (!found) return { status: 404, body: { ok: false, error: `no skill called "${String(body.name ?? '')}"` } };
      if (!found.dir) return { status: 400, body: { ok: false, error: 'A single-file skill has no folder to archive.' } };
      const { exportSkill } = await import('../skills/import.js');
      const dest = typeof body.dest === 'string' && body.dest.trim() ? body.dest.trim() : undefined;
      const result = await exportSkill(found.dir, dest, { includeEvals: body.includeEvals === true });
      if (!result.ok) return { status: 400, body: { ok: false, error: result.error } };
      return {
        status: 200,
        body: {
          ok: true, name: result.name, files: result.files, rewritten: result.rewritten, warnings: result.warnings ?? [],
          ...(result.path ? { path: result.path } : {}),
          ...(result.data ? { filename: `${result.name}.skill`, base64: result.data.toString('base64') } : {}),
        },
      };
    }

    case 'skills/import': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const source = String(body.source ?? '').trim();
      if (!source) return { status: 400, body: { error: 'source required' } };
      return importLegacy({ path: source }, body, human, needsHuman);
    }

    /**
     * A skill uploaded from the browser, in any of the shapes people have one.
     *
     * The path-based import assumes the browser and the server share a
     * filesystem, which is true when you launched both and false the moment
     * anyone opens the portal from another machine. It also assumes people know
     * the absolute path of a file they just downloaded, which they do not.
     *
     * So the bytes come over the wire and land in a temp directory, and from
     * there it is the same `importSkill` as everything else — one code path
     * that already knows about Claude directory skills, zips, bare SKILL.md,
     * and the wrapper folder a zip usually adds.
     *
     * Three shapes arrive here:
     *   - `files`: a folder the user picked, each entry with its relative path
     *   - `files` of one `.zip`/`.skill`: the archive is written and unpacked
     *   - `markdown`: SKILL.md pasted straight in
     */
    case 'skills/upload': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const markdown = typeof body.markdown === 'string' ? body.markdown : '';
      const files = Array.isArray(body.files) ? (body.files as Array<{ path?: unknown; base64?: unknown }>).map(f => ({ path: String(f.path ?? ''), base64: String(f.base64 ?? '') })) : [];
      if (!markdown.trim() && files.length === 0) return { status: 400, body: { ok: false, error: 'Nothing uploaded.' } };
      return importLegacy(markdown.trim() ? { markdown } : { files }, body, human, needsHuman);
    }

    case 'skills/create': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const name = String(body.name ?? '').trim();
      const description = String(body.description ?? '').trim();
      const content = String(body.body ?? '').trim();
      if (!name || !description) {
        return { status: 400, body: { error: 'name and description are both required' } };
      }
      const fs = await import('fs');
      const path = await import('path');
      const { userSkillsDir } = await import('../skills/import.js');
      const dir = path.join(userSkillsDir(), name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-'));
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'SKILL.md'),
          `---
name: ${name}
description: ${description}
---
${content || 'Describe the procedure here.'}
`,
          'utf8');
      } catch (err) {
        return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
      }
      const { skillRegistry } = await import('../skills/registry.js');
      await skillRegistry.load({});
      return { status: 200, body: { ok: true, name, installedAt: dir } };
    }

    case 'skills/remove': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const name = String(body.name ?? '');
      const { removeSkill } = await import('../skills/import.js');
      const result = removeSkill(name);
      if (result.ok) {
        const { skillRegistry } = await import('../skills/registry.js');
        await skillRegistry.load({});
      }
      return { status: result.ok ? 200 : 400, body: result };
    }

    // ── MCP ──────────────────────────────────────────────────────────
    case 'mcp/add': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const { addMcpServer } = await import('../mcp/manage.js');
      try {
        const out = await addMcpServer(body as never);
        return { status: 200, body: { ok: true, result: out } };
      } catch (err) {
        return { status: 400, body: { ok: false, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    case 'mcp/remove': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const { removeMcpServer } = await import('../mcp/manage.js');
      try {
        const out = await removeMcpServer(String(body.name ?? ''));
        return { status: 200, body: { ok: true, result: out } };
      } catch (err) {
        return { status: 400, body: { ok: false, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    /**
     * Say what a pasted config means, without writing anything.
     *
     * Separate from adding it so the panel can show what will happen while the
     * text is still on screen. Validating only when you press the button makes
     * the error land after the decision rather than before it.
     */
    case 'mcp/validate': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const { parseMcpConfig } = await import('../mcp/manage-tool.js');
      return { status: 200, body: parseMcpConfig(String(body.json ?? '')) };
    }

    case 'mcp/reload': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const { reloadMcpServers } = await import('../mcp/manage.js');
      try {
        return { status: 200, body: { ok: true, result: await reloadMcpServers() } };
      } catch (err) {
        return { status: 400, body: { ok: false, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    // ── registry management ──────────────────────────────────────────
    //
    // One route for every verb on every registry, and it calls exactly the
    // executors the agent calls. That is the point: the panel and the
    // orchestrator are two front doors to one implementation, so a rule added
    // for one — a draft that must be verified before it registers, a built-in
    // that cannot be deleted — holds for the other without being written
    // twice. Two code paths for the same operation is how they drift.
    case 'manage': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const registry = String(body.registry ?? '');
      const input = { ...body };
      delete (input as Record<string, unknown>).registry;

      try {
        let result: string;
        switch (registry) {
          case 'skills': {
            const { executeSkillManage } = await import('../skills/manage.js');
            // Enabling an imported skill is the human review (design §5.1):
            // the gate is asked only for that, and only a proven person passes.
            const wantsHuman = input.action === 'enable' || input.enable === true;
            const person = wantsHuman ? (await human()).ok : false;
            result = await executeSkillManage(input as never, { human: person });
            break;
          }
          case 'agents': {
            const { executeAgentManage } = await import('../tools/manage-agents.js');
            result = await executeAgentManage(input as never);
            break;
          }
          case 'tools': {
            const { executeToolManage } = await import('../custom-tools/manage.js');
            // Enabling, deleting an enabled tool and executing a test are a
            // person's acts (design §5.2): only a proven person passes.
            const wantsHuman = input.action === 'enable' || input.action === 'test' || input.action === 'delete';
            const person = wantsHuman ? (await human()).ok : false;
            result = await executeToolManage(input as never, { human: person, cwd: process.cwd() });
            break;
          }
          case 'mcp': {
            const { executeMcpManage } = await import('../mcp/manage-tool.js');
            // Approving a changed tool and rewriting settings to move secrets
            // are a person's acts (design §5.3): only a proven person passes.
            const wantsHuman = input.action === 'approve' || input.action === 'secure';
            const person = wantsHuman ? (await human()).ok : false;
            result = await executeMcpManage(input as never, { human: person });
            break;
          }
          case 'memory': {
            const { executeMemoryManage } = await import('../tools/manage-memory.js');
            result = await executeMemoryManage(input as never);
            break;
          }
          default:
            return { status: 400, body: { ok: false, error: `Unknown registry "${registry}".` } };
        }
        // The executors report refusals as text rather than throwing, so the
        // panel has to read the reply to know whether it worked.
        const refused = /^(Not |No |There is no |Unknown |Nothing |Give either|A name is required|A path is required|An id is required)/.test(result);
        return { status: 200, body: { ok: !refused, result } };
      } catch (err) {
        return { status: 400, body: { ok: false, error: err instanceof Error ? err.message : String(err) } };
      }
    }

    // Custom tools for Settings → Tools: every one visible from the server's
    // directory, with status, validation and the command it runs (secret
    // names only — a definition never holds a value).
    case 'custom-tools': {
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
      const { toolsForPanel } = await import('../custom-tools/manage.js');
      return { status: 200, body: { tools: await toolsForPanel(process.cwd()) } };
    }

    case 'memory': {
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
      const { applicable, listScope } = await import('../memory/store.js');
      const scope = query.get('scope');
      const found = scope && scope !== 'all'
        ? listScope(scope as never, query.get('belongsTo') ?? undefined)
        : applicable(process.cwd(), query.get('session') ?? undefined);
      return {
        status: 200,
        body: {
          memories: found.map(m => ({
            id: m.id, scope: m.scope, text: m.text, tags: m.tags, enabled: m.enabled,
            updatedAt: m.updatedAt, belongsTo: m.belongsTo,
            pinned: m.pinned === true, status: m.status ?? 'active',
            ...(m.supersededBy ? { supersededBy: m.supersededBy } : {}),
          })),
        },
      };
    }

    case 'system':
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
      return { status: 200, body: await systemSnapshot() };

    case 'providers': {
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
      const settings = await loadSettings();
      return {
        status: 200,
        body: {
          // Every instance, with its secret removed but its provenance kept.
          instances: listInstances(settings).map(redactInstance),
          // The family catalog, so the add dialog can offer types, their
          // default endpoints, and the hint explaining when to pick each.
          types: PROVIDER_TYPE_IDS.map(id => PROVIDER_TYPES[id]),
          active: settings.activeProvider ?? settings.provider ?? null,
          model: settings.model ?? null,
        },
      };
    }

    case 'providers/models': {
      if (method !== 'GET' && method !== 'POST') return { status: 405, body: { error: 'GET or POST' } };
      const settings = await loadSettings();
      const wanted = typeof body.id === 'string' && body.id
        ? body.id
        : (settings.activeProvider ?? settings.provider ?? '');
      const instance = listInstances(settings).find(i => i.id === wanted)
        ?? listInstances(settings).find(i => i.type === wanted)
        ?? listInstances(settings)[0];
      if (!instance) return { status: 200, body: { models: [], source: 'none' } };

      // Whatever the instance already knows, first. That list came from asking
      // the endpoint what it serves, and a picker that made a network call
      // every time it opened would be a picker nobody keeps open.
      if (instance.models?.length) {
        return {
          status: 200,
          body: {
            models: instance.models,
            capabilities: describeCapabilities(instance.models, settings),
            source: 'stored',
            provider: instance.id,
            defaultModel: instance.defaultModel ?? null,
          },
        };
      }

      const { resolveApiKey } = await import('../providers/instances.js');
      const probe = await testInstance({
        type: instance.type,
        apiKey: resolveApiKey(instance),
        baseUrl: instance.baseUrl || undefined,
      });
      // A catalogue that says what each model takes is believed over the
      // prefix table, and kept on disk — free, since it was fetched anyway.
      recordCatalogueModalities(instance.id, probe.inputModalities);
      // Remembered, so the next open is instant and the settings screen shows
      // the same catalogue this picker just discovered.
      if (probe.models?.length) {
        const stored = settings.providerInstances ?? [];
        const merged = stored.some(i => i.id === instance.id)
          ? stored.map(i => (i.id === instance.id ? { ...i, models: probe.models } : i))
          : [...stored, { ...instance, models: probe.models }];
        await saveUserSetting('providerInstances', merged);

        // Endpoints that volunteer a context length are believed, because the
        // alternative is a 128K guess that is wrong in both directions —
        // compacting a 1M-context model eight times too early, or overrunning
        // an 8K one. Free: the catalogue was already fetched for the picker.
        //
        // Never overwrites an existing entry. That map is also where a reader
        // corrects a wrong value by hand, and a re-fetch that clobbered the
        // correction would undo it every time the picker was opened.
        const discovered = probe.contextWindows ?? {};
        const known = settings.contextWindows ?? {};
        const additions = Object.fromEntries(
          Object.entries(discovered).filter(([model]) => known[model] === undefined),
        );
        if (Object.keys(additions).length > 0) {
          await saveUserSetting('contextWindows', { ...known, ...additions });
        }
      }
      return {
        status: 200,
        body: {
          models: probe.models ?? [],
          capabilities: describeCapabilities(probe.models ?? [], settings),
          source: 'fetched',
          provider: instance.id,
          defaultModel: instance.defaultModel ?? null,
          ...(probe.error ? { error: probe.error } : {}),
        },
      };
    }

    /*
      What "Auto" reasoning sends, per provider family.

      Its own route rather than a field on the generic settings screen, because
      the setting lives under `providers.<type>`, a credential root: the client
      sees that subtree redacted, and posting it back through the settings
      route would overwrite the family's key with nothing. This writes one
      family's tuning keys and no others (see `patchUserProviderTuning`).
    */
    case 'providers/tuning': {
      if (method === 'GET') {
        const settings = await loadSettings();
        const tuning = (settings.providers ?? {}) as Record<string, Record<string, unknown> | undefined>;
        const families: Record<string, FamilyDefault> = {};
        for (const type of Object.keys(FAMILY_REASONING)) families[type] = tuningChoice(type, tuning[type]);
        return { status: 200, body: { families } };
      }
      if (method !== 'POST') return { status: 405, body: { error: 'GET or POST' } };
      const type = String(body.type ?? '');
      const choice = String(body.choice ?? '') as FamilyDefault;
      const family = FAMILY_REASONING[type];
      if (!family) return { status: 400, body: { error: `"${type}" takes no default reasoning setting` } };
      if (!family.choices.includes(choice)) {
        return { status: 400, body: { error: `"${choice}" is not a level ${type} can be set to (${family.choices.join(', ')})` } };
      }
      const patch = tuningPatch(type, choice)!;
      const stored = await patchUserProviderTuning(type, patch);
      return { status: 200, body: { type, choice: tuningChoice(type, stored) } };
    }

    case 'providers/save': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const settings = await loadSettings();
      const draft = (body.instance ?? {}) as Partial<ProviderInstance>;
      const stored = settings.providerInstances ?? [];
      const all = listInstances(settings);
      // "New" means no instance with this id exists *anywhere*, not just in the
      // explicitly-stored list. Checking only `stored` while validating against
      // `all` made every edit of a derived provider — which is every provider
      // on a fresh install, since they come from environment keys — look like a
      // create that collided with itself: "a provider with that id already
      // exists", on the provider you were editing.
      const isNew = !all.some(i => i.id === draft.id);

      const problems = validateInstance(draft, all, { isNew });
      if (problems.length > 0) return { status: 400, body: { error: problems[0], problems } };

      // A blank key on an edit means "leave it alone", not "clear it". Clearing
      // is an explicit action, because typing over a password field and then
      // giving up should not silently disconnect a working provider.
      // Editing a derived provider materializes it: the previous values come
      // from wherever it was derived, and the result is stored explicitly.
      const previous = stored.find(i => i.id === draft.id) ?? all.find(i => i.id === draft.id);
      const submittedKey = typeof draft.apiKey === 'string' ? draft.apiKey.trim() : undefined;
      const apiKey = submittedKey
        ? submittedKey
        : (body.clearKey === true ? undefined : previous?.apiKey);

      const instance = normalize({
        ...previous,
        ...draft,
        id: String(draft.id),
        type: draft.type as ProviderInstance['type'],
        name: draft.name ?? '',
        ...(apiKey ? { apiKey } : {}),
      });
      // The derived flag describes where a record came from; one that has been
      // saved is now user-authored regardless of how it first appeared.
      delete instance.derived;

      const existsInStored = stored.some(i => i.id === instance.id);
      const next = existsInStored
        ? stored.map(i => (i.id === instance.id ? instance : i))
        : [...stored, instance];
      await saveUserSetting('providerInstances', next);

      return { status: 200, body: { instance: redactInstance(instance) } };
    }

    case 'providers/delete': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const id = String(body.id ?? '');
      if (!id) return { status: 400, body: { error: 'id required' } };
      const settings = await loadSettings();
      const stored = settings.providerInstances ?? [];
      const next = stored.filter(i => i.id !== id);
      await saveUserSetting('providerInstances', next);
      // Deleting the active provider leaves the setting pointing at nothing,
      // which resolves to "first usable" rather than to an error.
      if ((settings.activeProvider ?? settings.provider) === id) {
        await saveUserSetting('activeProvider', next[0]?.id ?? '');
      }
      return { status: 200, body: { deleted: stored.length !== next.length } };
    }

    case 'providers/activate': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const id = String(body.id ?? '');
      const model = typeof body.model === 'string' ? body.model : undefined;
      if (!id) return { status: 400, body: { error: 'id required' } };
      await saveUserSetting('activeProvider', id);
      if (model) {
        await saveUserSetting('model', model);
        /*
          The instance's own default too. Picking a model for a provider in
          Settings wrote the global default and nothing else, so the row's
          summary — which shows `provider.defaultModel` — never changed and the
          pick looked like it had not taken. It had; it was just written to
          the one place the row does not read.
        */
        const settings = await loadSettings();
        const target = listInstances(settings).find(i => i.id === id);
        if (target) {
          const stored = settings.providerInstances ?? [];
          const { derived: _derived, ...materialised } = { ...target, defaultModel: model };
          const next = stored.some(i => i.id === id)
            ? stored.map(i => (i.id === id ? { ...i, defaultModel: model } : i))
            : [...stored, materialised];
          await saveUserSetting('providerInstances', next);
        }
      }
      return { status: 200, body: { active: id, model: model ?? null } };
    }

    // ── the context window, by model ──────────────────────────────────
    //
    // Read for the meter's popover; written when a person knows better than
    // the table or the endpoint. A `user` figure is never re-detected — that
    // is what makes it worth typing.
    case 'context-window': {
      const { resolveWindow, setContextWindow, clearContextWindow } = await import('../context-window.js');
      if (method === 'GET') {
        const model = String(query.get('model') ?? '');
        if (!model) return { status: 400, body: { error: 'model required' } };
        const fact = resolveWindow(model, await loadSettings());
        return { status: 200, body: { model, tokens: fact.tokens, source: fact.source } };
      }
      if (method !== 'POST') return { status: 405, body: { error: 'GET or POST' } };
      const model = String(body.model ?? '');
      if (!model) return { status: 400, body: { error: 'model required' } };
      if (body.tokens === null) {
        await clearContextWindow(model);
        const fact = resolveWindow(model, await loadSettings());
        return { status: 200, body: { model, tokens: fact.tokens, source: fact.source, cleared: true } };
      }
      const tokens = Number(body.tokens);
      // The same bounds every detector applies. A typo of 1,000,000,000 is
      // not a window, and neither is 100.
      if (!Number.isInteger(tokens) || tokens < 1_000 || tokens > 20_000_000) {
        return { status: 400, body: { error: 'tokens must be a whole number between 1,000 and 20,000,000' } };
      }
      await setContextWindow(model, tokens, { source: 'user' });
      return { status: 200, body: { model, tokens, source: 'user' } };
    }

    case 'provider-test':
    case 'providers/test': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const settings = await loadSettings();

      // Two shapes: an id (test what is configured) or a draft (test what is
      // being typed, before it is saved). The draft form is what makes the add
      // dialog able to say "this key works" before committing anything.
      const id = typeof body.id === 'string' ? body.id : undefined;
      if (id) {
        const instance = listInstances(settings).find(i => i.id === id);
        if (!instance) return { status: 404, body: { error: `No provider "${id}"` } };
        const { resolveApiKey } = await import('../providers/instances.js');
        const tested = await testInstance({
          type: instance.type,
          apiKey: resolveApiKey(instance),
          baseUrl: instance.baseUrl || undefined,
        });
        recordCatalogueModalities(instance.id, tested.inputModalities);
        /*
          Naming a model extends the test from "does the key work" to "does
          this model read images" — one real request with a tiny picture. Only
          when asked: it is the one part of a connection test that costs money.
        */
        const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined;
        if (model && tested.ok) {
          const { probeModelImageInput } = await import('../providers/capability-probe.js');
          const imageProbe = await probeModelImageInput({ settings, model, provider: instance.id })
            .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }));
          return { status: 200, body: { ...tested, imageProbe } };
        }
        return { status: 200, body: tested };
      }

      const type = String(body.type ?? body.provider ?? '');
      if (!type) return { status: 400, body: { error: 'type or id required' } };
      let apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';
      if (!apiKey) {
        // Blank means "use what is already configured", so a user can verify a
        // stored or environment key without retyping a secret.
        const existing = listInstances(settings).find(i => i.type === type);
        if (existing) {
          const { resolveApiKey } = await import('../providers/instances.js');
          apiKey = resolveApiKey(existing);
        }
      }
      const baseUrl = typeof body.baseUrl === 'string' && body.baseUrl ? body.baseUrl : undefined;
      const tested = await testProvider(type, apiKey, baseUrl);
      // What the models take is a fact about the models, true whether or not
      // this draft is saved.
      if (tested.ok) recordCatalogueModalities(type, tested.inputModalities);
      return { status: 200, body: tested };
    }

    /*
      Does this model read images? Found out by showing it one.

      A real request — a small solid-colour PNG and "what colour is this?" —
      classified into reads images / does not / could not tell, and the first
      two remembered on disk so the capability gate, the picker and every
      later run use the answer. Only ever run on request: see
      `providers/capability-probe` for why the ambiguous cases record nothing.
    */
    case 'models/probe': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const model = typeof body.model === 'string' ? body.model.trim() : '';
      if (!model) return { status: 400, body: { error: 'model required' } };
      const provider = typeof body.provider === 'string' && body.provider ? body.provider : undefined;
      const { probeModelImageInput } = await import('../providers/capability-probe.js');
      try {
        const result = await probeModelImageInput({
          settings: await loadSettings(), model, ...(provider ? { provider } : {}),
        });
        return { status: 200, body: result };
      } catch (err) {
        return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
      }
    }

    case 'settings': {
      const settings = await loadSettings();
      if (method === 'GET') {
        return { status: 200, body: redactSettings(settings) };
      }
      if (method !== 'POST') return { status: 405, body: { error: 'GET or POST' } };
      {
        const weakens = safetyWeakening(settings, body as Record<string, unknown>);
        if (weakens) { const h = await human(); if (!h.ok) return needsHuman(`${weakens} needs a person in the AICO window; the API token alone cannot do it.`); }
      }
      // Applied key by key so a partial update cannot blank the rest of the file.
      for (const [key, value] of Object.entries(body)) {
        await saveUserSetting(key, value);
      }
      return { status: 200, body: redactSettings(await loadSettings()) };
    }

    // One value by dotted path, global file only; `null` removes it.
    case 'settings/path': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST' } };
      const { path: dotted, value } = body as { path?: unknown; value?: unknown };
      if (typeof dotted !== 'string' || !dotted.trim()) return { status: 400, body: { error: 'path required' } };
      {
        const patch = dotted.split('.').reduceRight<unknown>((acc, k) => ({ [k]: acc }), value ?? null) as Record<string, unknown>;
        const weakens = safetyWeakening(await loadSettings(), patch);
        if (weakens) { const h = await human(); if (!h.ok) return needsHuman(`${weakens} needs a person in the AICO window; the API token alone cannot do it.`); }
      }
      try {
        await patchUserSettingPath(dotted, value === undefined ? null : value);
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } };
      }
      return { status: 200, body: redactSettings(await loadSettings()) };
    }

    /*
      The Tasks panel's list (work/tasks): live and recent work with model,
      tokens, step text, todo progress and output tails, plus what waits for
      a person. A read; the live form is the `tasks/events` topic. Strings are
      redacted in the projection and again here, as every sink is.
    */
    case 'tasks': {
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
      const { tasksSnapshot } = await import('../work/tasks.js');
      const { sinkRedact } = await import('../vault/sink.js');
      return { status: 200, body: sinkRedact(await tasksSnapshot()) };
    }

    /*
      Stop anything in the ledger, by id.

      One route rather than one per kind: the ledger already knows how to stop
      each thing, and a UI that needed a different endpoint for an agent, a
      process and a scheduled run would be the five-registries problem again,
      wearing an HTTP hat.
    */
    case 'work/stop': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const id = typeof body.id === 'string' ? body.id : '';
      if (!id) return { status: 400, body: { error: 'id required' } };
      const record = ledger.get(id);
      if (!record) return { status: 404, body: { error: `No work "${id}"` } };
      if (isTerminalWork(record.state)) {
        return { status: 200, body: { stopped: false, state: record.state, reason: 'already finished' } };
      }
      const reason = typeof body.reason === 'string' && body.reason.trim()
        ? body.reason.trim()
        : 'Stopped from the panel';

      for (const child of ledger.descendants(id).reverse()) {
        if (isTerminalWork(child.state)) continue;
        await stopWork(child.id, 'stop', `parent ${id} stopped — ${reason}`,
          () => { ledger.close(child.id, 'cancelled', `Stopped with parent: ${reason}`); });
      }
      // Outcome first, then the signal, so the reason recorded is this one and
      // not whatever the stopped subsystem says about itself.
      const stopped = await stopWork(id, 'stop', reason,
        () => { ledger.close(id, 'cancelled', reason); });
      return { status: 200, body: { stopped, state: 'cancelled' } };
    }

    case 'work/ack': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const raw = body.id;
      const idList = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
      return { status: 200, body: { acknowledged: ledger.acknowledge(idList) } };
    }

    case 'background/cancel': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const agentId = String(body.agentId ?? '');
      if (!agentId) return { status: 400, body: { error: 'agentId required' } };
      return { status: 200, body: { cancelled: cancelBackgroundAgent(agentId) } };
    }

    case 'cron/delete':
    case 'cron/pause':
    case 'cron/resume': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const jobId = String(body.jobId ?? body.job_id ?? '');
      if (!jobId) return { status: 400, body: { error: 'jobId required' } };
      const action = route.slice('cron/'.length);
      const result =
        action === 'delete' ? await executeCronDelete({ job_id: jobId })
        : action === 'pause' ? await executeCronPause({ job_id: jobId })
        : await executeCronResume({ job_id: jobId });
      return { status: 200, body: result };
    }

    default:
      return undefined;
  }
}

/**
 * Strip every secret before settings cross the wire.
 *
 * Recursive, and keyed on the *field name* rather than on a list of known
 * locations. The previous version redacted `providers.<vendor>.apiKey` and
 * nothing else, so the moment `providerInstances` was added — an array of
 * records each holding its own key — every one of those keys began flowing to
 * the client. A redactor that has to be taught each new hiding place will
 * always be one commit behind the thing it is protecting.
 *
 * Presence is preserved as `hasKey`, because a settings screen legitimately
 * needs to know whether something is configured; it never needs the value.
 */
function redactSettings(settings: AicoSettings): Record<string, unknown> {
  return redactDeep(settings) as Record<string, unknown>;
}

/** Field names whose values never leave the server, at any depth. */
const SECRET_FIELDS = new Set(['apiKey', 'api_key', 'token', 'secret', 'password']);

function redactDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDeep);
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELDS.has(key)) {
      // Recorded as a boolean beside the field it replaces, so a caller can
      // tell "configured" from "absent" without ever seeing the value.
      if (inner) out[`has${key.charAt(0).toUpperCase()}${key.slice(1)}`] = true;
      continue;
    }
    out[key] = redactDeep(inner);
  }
  return out;
}

/**
 * What each model in a catalogue takes and returns, keyed by id.
 *
 * Sent beside the list rather than folded into it: the list is a contract the
 * picker already reads, and callers that only want ids should not have to
 * learn a new shape to keep working.
 *
 * Every entry is answered, including the ones nothing describes — `known:
 * false` is the useful half of the answer. A picker that showed a badge only
 * for models it recognised would leave the reader unable to tell "text only"
 * apart from "not labelled yet", and those call for different actions.
 */
function describeCapabilities(
  models: readonly string[],
  settings: AicoSettings,
): Record<string, ModelCapabilities> {
  const out: Record<string, ModelCapabilities> = {};
  for (const model of models) out[model] = getModelCapabilities(model, settings);
  return out;
}

/**
 * The older one-step import routes (`skills/import`, `skills/upload`), kept
 * for clients that have not moved to review → install. They stage and
 * install in one call, and land `unreviewed` unless the request proves a
 * person is present and asks to enable (`enable: true` → reviewed) or says
 * the person wrote it themselves in the editor (`authored: true`). The
 * response keeps the old `{ ok, name, installedAt, resources, replaced }` shape.
 */
async function importLegacy(
  input: { path: string } | { files: Array<{ path: string; base64: string }> } | { markdown: string },
  body: Record<string, unknown>,
  human: () => Promise<{ ok: boolean; reason?: string }>,
  needsHuman: (reason?: string) => { status: number; body: unknown },
): Promise<{ status: number; body: unknown }> {
  const authored = body.authored === true;
  const enable = body.enable === true || authored;
  if (enable) {
    const verdict = await human();
    if (!verdict.ok) return needsHuman(verdict.reason);
  }
  const { stageImport, installStaged } = await import('../skills/import.js');
  const { writeMeta, readMeta, treeHash } = await import('../skills/provenance.js');
  const { setEnabled } = await import('../registry-state.js');
  const review = await stageImport(input);
  if ('error' in review) return { status: 400, body: { ok: false, error: review.error } };
  const out = installStaged(review.id, { trust: enable ? 'reviewed' : 'unreviewed', overwrite: body.overwrite === true });
  for (const sk of out.installed) {
    if (enable) setEnabled('skills', sk.name, true);
    // The person's own skill from the editor: authored, so editing it later
    // does not send it back for review.
    if (authored) {
      const meta = readMeta(sk.installedAt);
      if (meta) writeMeta(sk.installedAt, { ...meta, trust: 'authored', sha256: treeHash(sk.installedAt) });
    }
  }
  const { skillRegistry } = await import('../skills/registry.js');
  await skillRegistry.reload();
  const first = out.installed[0];
  if (!first) {
    const why = out.skipped[0]?.reason ?? 'nothing installable was found';
    return { status: 400, body: { ok: false, error: /already installed/.test(why) ? why.replace(/ — choose replace.*$/, '. Import again with overwrite to replace it.') : why } };
  }
  const reviewed = review.skills.find(r => r.name === first.name);
  return {
    status: 200,
    body: {
      ok: true, name: first.name, installedAt: first.installedAt,
      resources: (reviewed?.files ?? []).map(f => f.path).filter(f => !/^skill\.md$/i.test(f)),
      ...(first.replaced ? { replaced: true } : {}),
      trust: authored ? 'authored' : first.trust,
      installed: out.installed, skipped: out.skipped,
    },
  };
}

/**
 * What a settings write would weaken, if anything. The model can hold the API
 * token (it runs `curl` like anyone), so switching the safety reviewer off or
 * to "proceed without asking", or letting personal data leave the machine,
 * must come from a person — the same rule as approving a parked call. Making
 * things stricter needs nothing. Pure; exported for tests.
 */
export function safetyWeakening(current: object | undefined, patch: Record<string, unknown>): string | undefined {
  const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
  const cur = obj(current as unknown) ?? {};
  const sent = obj(patch.sentinel);
  if (sent) {
    const was = obj(cur.sentinel) ?? {};
    if (sent.onEscalate === 'proceed' && was.onEscalate !== 'proceed') return 'Turning on full autonomy';
    if (sent.mode === 'off' && was.mode !== 'off') return 'Turning the safety reviewer off';
    const agents = obj(sent.agents);
    if (agents && Object.entries(agents).some(([k, v]) => v === 'off' && obj(was.agents)?.[k] !== 'off')) return 'Turning the safety reviewer off for an agent';
  }
  const models = obj(patch.models);
  if (models) {
    const was = obj(cur.models) ?? {};
    const wasLocal = was.localOnlyPersonal === true || was.preset === 'private';
    const nowLocal = (models.localOnlyPersonal ?? was.localOnlyPersonal) === true || (models.preset ?? was.preset) === 'private';
    if (wasLocal && !nowLocal) return 'Letting personal data leave this machine';
  }
  return undefined;
}
