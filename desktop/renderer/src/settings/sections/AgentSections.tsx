/**
 * The agent's settings: providers and models, skills, MCP servers, agents,
 * and every engine pane of the shared schema (permissions, context, limits,
 * memory).
 *
 * @module desktop/renderer/settings/sections/AgentSections
 */

import React, { useCallback, useEffect, useState } from 'react';
import { api, type ProviderInstance, type ProviderTypeInfo } from '@web/api';
import { ModelCombobox } from '@/shell/ModelCombobox';
import { useStore } from '@web/store';
import { PANES } from '@web/settings-schema';
import { RolesPane } from '@web/components/settings/RolesPane';
import { toast } from '@/state/desk';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { EnginePane, Row, Switch } from '../fields';

export function enginePaneSection(id: string): React.ComponentType {
  const Pane = (): React.ReactElement => {
    const pane = PANES.find(p => p.id === id);
    return pane ? <EnginePane pane={pane} /> : <p className="text-aico-muted">Not available in this engine version.</p>;
  };
  Pane.displayName = `EnginePane(${id})`;
  return Pane;
}

export function ModelsSection(): React.ReactElement {
  const [data, setData] = useState<{ instances: ProviderInstance[]; types: ProviderTypeInfo[]; active: string | null; model: string | null } | null>(null);
  const [editing, setEditing] = useState<Partial<ProviderInstance> | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const refreshProviders = useStore(s => s.refreshProviders);
  const load = useCallback(async () => { try { setData(await api.providers()); } catch (e) { toast.error('Could not load providers', (e as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);

  const activate = async (id: string): Promise<void> => {
    try { await api.activateProvider(id); await load(); await refreshProviders(); toast.success('Provider activated'); }
    catch (e) { toast.error('Could not activate', (e as Error).message); }
  };
  /**
   * Connects, lists the models, and shows the default model a tiny picture to
   * learn whether it reads images. The answer is remembered on this computer
   * (the engine's capability cache), so every picker and the agent itself know
   * it from then on — one small request, only when asked.
   */
  const test = async (p: ProviderInstance): Promise<void> => {
    setTesting(p.id);
    try {
      const model = p.defaultModel ?? typeOf(p.type)?.defaultModel ?? undefined;
      const r = await api.testProvider(p.id, model);
      if (!r.ok) { toast.error('Connection failed', r.error); return; }
      const probe = r.imageProbe;
      const vision = !probe ? '' : 'verdict' in probe
        ? probe.verdict === 'image' ? ` · ${model} reads images` : probe.verdict === 'text-only' ? ` · ${model} is text-only` : ` · image support unknown (${probe.reason})`
        : ` · image check failed: ${probe.error}`;
      toast.success('Connected', `${r.models?.length ?? 0} models · ${r.latencyMs ?? '?'} ms${vision}`);
    } catch (e) { toast.error('Test failed', (e as Error).message); }
    finally { setTesting(null); }
  };
  const remove = async (id: string): Promise<void> => {
    try { await api.deleteProvider(id); await load(); await refreshProviders(); } catch (e) { toast.error('Could not remove', (e as Error).message); }
  };
  const save = async (): Promise<void> => {
    if (!editing) return;
    try {
      await api.saveProvider(editing);
      setEditing(null); await load(); await refreshProviders();
      toast.success('Provider saved');
    } catch (e) { toast.error('Could not save', (e as Error).message); }
  };

  if (!data) return <div className="space-y-2">{[0, 1, 2].map(i => <div key={i} className="skeleton h-14" />)}</div>;
  const typeOf = (t: string): ProviderTypeInfo | undefined => data.types.find(x => x.type === t);
  return (
    <div>
      <p className="-mt-2 mb-4 text-[13px] text-aico-muted">Providers are called directly from this computer with your keys. The active one answers new chats; any chat can pick another model.</p>
      <div className="set-group">
        {data.instances.map(p => (
          <Row key={p.id}
            title={<span className="flex items-center gap-2">{p.name}{data.active === p.id && <span className="badge bg-aico-accent-soft text-aico-accent">Active</span>}</span>}
            desc={<>{typeOf(p.type)?.label ?? p.type} · {p.defaultModel ?? typeOf(p.type)?.defaultModel ?? 'default model'} · key {p.keySource === 'none' ? <span className="text-aico-warning">missing</span> : p.keySource === 'environment' ? 'from environment' : p.keySource === 'not-required' ? 'not needed' : 'saved'}</>}>
            <div className="flex items-center gap-1.5">
              <button className="btn-outline btn-sm" onClick={() => void test(p)} disabled={testing === p.id} title="Connect, list models, and check whether the default model reads images">{testing === p.id ? <span className="spinner h-3 w-3" /> : null}Test</button>
              {data.active !== p.id && <button className="btn-outline btn-sm" onClick={() => void activate(p.id)}>Use</button>}
              {!p.derived && <button className="icon-btn-sm" onClick={() => setEditing({ ...p, apiKey: '' })} aria-label={`Edit ${p.name}`}><Icon name="edit" size={14} /></button>}
              {!p.derived && data.active !== p.id && <button className="icon-btn-sm" onClick={() => void remove(p.id)} aria-label={`Remove ${p.name}`}><Icon name="trash" size={14} /></button>}
            </div>
          </Row>
        ))}
        {data.instances.length === 0 && <Row title="No providers yet" desc="Add one to start chatting." />}
      </div>
      <button className="btn-outline mt-3" onClick={() => setEditing({ type: data.types[0]?.type, name: '', apiKey: '' })}><Icon name="plus" size={14} />Add provider</button>

      {editing && (
        <div className="mt-4 rounded-xl border border-aico-border-subtle p-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1"><span className="label">Type</span>
              <select className="select" value={editing.type} onChange={e => setEditing({ ...editing, type: e.target.value as ProviderInstance['type'] })} disabled={Boolean(editing.id)}>
                {data.types.map(t => <option key={t.type} value={t.type}>{t.label}</option>)}
              </select>
            </label>
            <label className="space-y-1"><span className="label">Name</span>
              <input className="input" value={editing.name ?? ''} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder={typeOf(editing.type ?? '')?.label} />
            </label>
            <label className="col-span-2 space-y-1"><span className="label">API key {editing.id && <span className="text-aico-muted">(leave blank to keep the saved one)</span>}</span>
              <input className="input font-mono" type="password" value={editing.apiKey ?? ''} onChange={e => setEditing({ ...editing, apiKey: e.target.value })} placeholder={typeOf(editing.type ?? '')?.envVar ? `or set ${typeOf(editing.type ?? '')!.envVar}` : ''} autoComplete="off" />
            </label>
            <label className="space-y-1"><span className="label">Base URL</span>
              <input className="input font-mono" value={editing.baseUrl ?? ''} onChange={e => setEditing({ ...editing, baseUrl: e.target.value })} placeholder={typeOf(editing.type ?? '')?.defaultBaseUrl} />
            </label>
            <div className="space-y-1"><span className="label">Default model</span>
              <ModelCombobox
                key={`${editing.id ?? 'new'}:${editing.type}`}
                value={editing.defaultModel ?? ''}
                onChange={v => setEditing(e => e && { ...e, defaultModel: v })}
                placeholder={typeOf(editing.type ?? '')?.defaultModel ?? 'search models'}
                probe={editing.id ? (m => api.probeModel(m, editing.id)) : undefined}
                load={async () => {
                  // A saved provider answers from its catalogue (with capabilities);
                  // one being typed is asked with the key and URL as they stand.
                  if (editing.id && !editing.apiKey && !editing.baseUrl) {
                    const r = await api.providerModels(editing.id);
                    return { models: r.models.map(id => ({ id, ...(r.capabilities?.[id] ?? {}) })), error: r.error };
                  }
                  const r = editing.id
                    ? await api.testProvider(editing.id)
                    : await api.testProviderDraft({ type: editing.type ?? '', apiKey: editing.apiKey || undefined, baseUrl: editing.baseUrl || undefined });
                  if (!r.ok) return { models: [], error: `${r.error ?? 'Could not list models'} — enter the key first, or type a model id.` };
                  return { models: (r.models ?? []).map(id => ({ id })) };
                }}
              />
            </div>
          </div>
          {typeOf(editing.type ?? '')?.hint && <p className="mt-2 text-[12px] text-aico-muted">{typeOf(editing.type ?? '')!.hint}</p>}
          <div className="mt-3 flex justify-end gap-2">
            <button className="btn-outline" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn-primary" onClick={() => void save()}>Save</button>
          </div>
        </div>
      )}

      {/* Which model does which job (ADR 0017): the engine's shared page. */}
      <RolesPane />
    </div>
  );
}

export function McpSection(): React.ReactElement {
  const system = useStore(s => s.system);
  const refreshSystem = useStore(s => s.refreshSystem);
  const [adding, setAdding] = useState(false);
  const [json, setJson] = useState('{\n  "name": "my-server",\n  "type": "stdio",\n  "command": "npx",\n  "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]\n}');
  useEffect(() => { void refreshSystem(); }, [refreshSystem]);
  const servers = system?.mcpServers ?? [];
  const toggle = async (name: string, enabled: boolean): Promise<void> => {
    try { await api.manage('mcp', { action: enabled ? 'enable' : 'disable', name }); await refreshSystem(); }
    catch (e) { toast.error('Could not change the server', (e as Error).message); }
  };
  const add = async (): Promise<void> => {
    try {
      const config = JSON.parse(json) as Record<string, unknown>;
      const r = await api.addMcpServer(config);
      if (!r.ok) throw new Error(r.error ?? 'refused');
      setAdding(false); await refreshSystem(); toast.success('MCP server added', r.result);
    } catch (e) { toast.error('Could not add it', (e as Error).message); }
  };
  const remove = async (name: string): Promise<void> => {
    try { const r = await api.removeMcpServer(name); if (!r.ok) throw new Error(r.error); await refreshSystem(); } catch (e) { toast.error('Could not remove it', (e as Error).message); }
  };
  const totalTools = servers.reduce((n, s) => n + (s.enabled ? s.toolCount : 0), 0);
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <div className="text-[13px] text-aico-muted">{servers.length} server{servers.length === 1 ? '' : 's'} · {totalTools} tools available to the agent</div>
        <div className="flex-1" />
        <button className="icon-btn-sm" onClick={() => void api.reloadMcpServers().then(() => refreshSystem())} title="Reconnect all" aria-label="Reconnect all"><Icon name="refresh" size={14} /></button>
        <button className="btn-outline btn-sm" onClick={() => setAdding(a => !a)}><Icon name="plus" size={13} />Add MCP</button>
      </div>
      <div className="set-group">
        {servers.length === 0 && <Row title="No MCP servers" desc="Add one to give the agent more tools." />}
        {servers.map(s => (
          <Row key={s.name}
            title={<span className={cls('flex items-center gap-2', !s.enabled && 'text-aico-muted line-through')}>{s.name}
              <span className={cls('h-1.5 w-1.5 rounded-full', s.health === 'healthy' ? 'bg-aico-success' : s.health === 'degraded' ? 'bg-aico-warning' : 'bg-aico-muted')} title={s.health} /></span>}
            desc={`${s.toolCount} tools ${s.enabled ? 'enabled' : 'disabled'}${s.resourceCount ? ` · ${s.resourceCount} resources` : ''}`}>
            {(s as { host?: boolean }).host ? (
              <span className="badge bg-aico-accent-soft text-aico-accent" title="The IDE's own tools for the agent — connected while this window is open">built in</span>
            ) : (
              <div className="flex items-center gap-2">
                <button className="icon-btn-sm" onClick={() => void remove(s.name)} aria-label={`Remove ${s.name}`}><Icon name="trash" size={14} /></button>
                <Switch checked={s.enabled} onChange={v => void toggle(s.name, v)} label={`Enable ${s.name}`} />
              </div>
            )}
          </Row>
        ))}
      </div>
      {adding && (
        <div className="mt-3 rounded-xl border border-aico-border-subtle p-4">
          <div className="label mb-1">Server configuration (JSON)</div>
          <textarea className="input min-h-[150px] font-mono text-[12.5px]" value={json} onChange={e => setJson(e.target.value)} spellCheck={false} />
          <p className="mt-1 text-[12px] text-aico-muted">stdio: <code>command</code> + <code>args</code>. HTTP/SSE: <code>"type": "http"</code> + <code>url</code> (+ <code>headers</code>).</p>
          <div className="mt-3 flex justify-end gap-2">
            <button className="btn-outline" onClick={() => setAdding(false)}>Cancel</button>
            <button className="btn-primary" onClick={() => void add()}>Add</button>
          </div>
        </div>
      )}
    </div>
  );
}

export { SkillsSection, AgentsSection } from './SkillsAgents';
