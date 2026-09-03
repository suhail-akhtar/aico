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
import { loadSettings, saveUserSetting } from '../settings.js';
import { getModelCapabilities } from '../model-capabilities.js';
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
    mcpServers: Object.keys(settings.mcpServers ?? {}).map(name => {
      const info = mcpRegistry.getServerInfos().find(s => s.name === name);
      return {
        name,
        enabled: !disabledMcp.has(name.toLowerCase()),
        health: info?.health ?? 'not loaded',
        toolCount: info?.toolCount ?? 0,
        resourceCount: info?.resourceCount ?? 0,
      };
    }),
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
): Promise<{ status: number; body: unknown } | undefined> {
  switch (route) {
    case 'agents': {
      if (method !== 'GET') return { status: 405, body: { error: 'GET only' } };
      const { listAgentSpecs } = await import('../agents/registry.js');
      const { disabledIn: disabledAgents } = await import('../registry-state.js');
      const specs = await listAgentSpecs();
      const offAgents = disabledAgents('agents');
      return {
        status: 200,
        body: {
          // The full prompt is deliberately not returned: it is thousands of
          // tokens per agent, the panel lists rather than reads, and nothing in
          // the browser has a use for it.
          agents: specs.map(spec => ({
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
      const offSkills = disabledIn('skills');
      return {
        status: 200,
        body: {
          skills: skillRegistry.list().map(s => ({
            name: s.frontmatter.name,
            description: s.frontmatter.description,
            builtin: s.isBuiltin,
            enabled: !offSkills.has(s.frontmatter.name.toLowerCase()),
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
      const found = skillRegistry.lookup(name);
      if (!found) return { status: 404, body: { error: `no skill called "${name}"` } };
      return { status: 200, body: { name: found.frontmatter.name, body: found.promptTemplate } };
    }

    case 'skills/import': {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const source = String(body.source ?? '').trim();
      if (!source) return { status: 400, body: { error: 'source required' } };
      const { importSkill } = await import('../skills/import.js');
      const result = await importSkill(source, { overwrite: body.overwrite === true });
      if (result.ok) {
        const { skillRegistry } = await import('../skills/registry.js');
        await skillRegistry.load({});
      }
      return { status: result.ok ? 200 : 400, body: result };
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
      const fsMod = await import('fs');
      const pathMod = await import('path');
      const osMod = await import('os');
      const { importSkill } = await import('../skills/import.js');

      const staging = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'aico-upload-'));
      try {
        let source = staging;
        const markdown = typeof body.markdown === 'string' ? body.markdown : '';
        const files = Array.isArray(body.files) ? body.files as Array<{ path?: string; base64?: string }> : [];

        if (markdown.trim()) {
          fsMod.writeFileSync(pathMod.join(staging, 'SKILL.md'), markdown, 'utf8');
        } else if (files.length > 0) {
          for (const file of files) {
            const relative = String(file.path ?? '').split('\\').join('/');
            if (!relative) continue;
            // The uploaded name decides where it lands, so it is checked the
            // same way a skill's own resources are.
            const target = pathMod.resolve(staging, relative);
            if (!target.startsWith(pathMod.resolve(staging) + pathMod.sep)) continue;
            fsMod.mkdirSync(pathMod.dirname(target), { recursive: true });
            fsMod.writeFileSync(target, Buffer.from(String(file.base64 ?? ''), 'base64'));
          }
          // A single archive is handed to importSkill as the archive, which
          // already knows how to unpack one on this platform.
          const written = files.map(f => String(f.path ?? '')).filter(Boolean);
          if (written.length === 1 && /\.(zip|skill)$/i.test(written[0]!)) {
            source = pathMod.join(staging, written[0]!);
          }
        } else {
          return { status: 400, body: { ok: false, error: 'Nothing uploaded.' } };
        }

        const result = await importSkill(source, { overwrite: body.overwrite === true });
        if (result.ok) {
          const { skillRegistry } = await import('../skills/registry.js');
          await skillRegistry.load({});
        }
        return { status: result.ok ? 200 : 400, body: result };
      } catch (err) {
        return { status: 400, body: { ok: false, error: err instanceof Error ? err.message : String(err) } };
      } finally {
        fsMod.rmSync(staging, { recursive: true, force: true });
      }
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
            result = await executeSkillManage(input as never);
            break;
          }
          case 'agents': {
            const { executeAgentManage } = await import('../tools/manage-agents.js');
            result = await executeAgentManage(input as never);
            break;
          }
          case 'mcp': {
            const { executeMcpManage } = await import('../mcp/manage-tool.js');
            result = await executeMcpManage(input as never);
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
        const { resolveApiKey, resolveBaseUrl } = await import('../providers/instances.js');
        return {
          status: 200,
          body: await testInstance({
            type: instance.type,
            apiKey: resolveApiKey(instance),
            baseUrl: instance.baseUrl || undefined,
          }),
        };
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
      return { status: 200, body: await testProvider(type, apiKey, baseUrl) };
    }

    case 'settings': {
      const settings = await loadSettings();
      if (method === 'GET') {
        return { status: 200, body: redactSettings(settings) };
      }
      if (method !== 'POST') return { status: 405, body: { error: 'GET or POST' } };
      // Applied key by key so a partial update cannot blank the rest of the file.
      for (const [key, value] of Object.entries(body)) {
        await saveUserSetting(key, value);
      }
      return { status: 200, body: redactSettings(await loadSettings()) };
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
