/**
 * Draws a user plugin's page.
 *
 * Declarative kinds (markdown, prompt board, links) are rendered by the app
 * itself with the shared Markdown renderer — so a plugin page can hold charts,
 * tables and formulas exactly like a chat reply. A `frame` view is the
 * plugin's own HTML in a sandboxed iframe with an opaque origin; it can ask
 * the host for a few things over postMessage (see `frame-rpc.ts`) and nothing
 * else.
 *
 * @module desktop/renderer/plugins/PluginView
 */

import React, { useEffect, useRef } from 'react';
import { MarkdownRenderer } from '@aico/ui';
import type { ResolvedView } from './registry';
import { runAction } from './registry';
import { Icon } from '@/lib/icons';
import { useDesk } from '@/state/desk';
import { desktop } from '@/desktop';
import { handleFrameMessage } from './frame-rpc';

export function PluginView({ view }: { view: ResolvedView }): React.ReactElement {
  const d = view.declarative!;
  const plugin = view.plugin!;
  const trusted = useDesk(s => s.prefs.plugins.trusted.includes(plugin.manifest.id));

  if (d.kind === 'markdown') {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="transcript mx-auto max-w-column px-6 py-8"><MarkdownRenderer content={d.markdown} /></div>
      </div>
    );
  }
  if (d.kind === 'prompt-board') {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-8 py-8">
          <h1 className="text-[24px] font-semibold">{d.title}</h1>
          {d.description && <p className="mt-1 text-[13.5px] text-aico-secondary">{d.description}</p>}
          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {d.prompts.map((p, i) => (
              <button key={i} className="card flex flex-col items-start gap-2 p-4 text-left transition-colors hover:bg-aico-hover"
                onClick={() => void runAction({ type: 'prompt', prompt: p.prompt, newChat: true }, plugin.manifest.id)}>
                <Icon name={p.icon ?? 'sparkles'} size={18} className="text-aico-accent" />
                <span className="text-[14px] font-medium">{p.title}</span>
                <span className="line-clamp-2 text-[12.5px] text-aico-muted">{p.prompt}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }
  if (d.kind === 'links') {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 py-8">
          <h1 className="text-[24px] font-semibold">{d.title}</h1>
          {d.description && <p className="mt-1 text-[13.5px] text-aico-secondary">{d.description}</p>}
          <div className="mt-6 divide-y divide-aico-border-subtle overflow-hidden rounded-xl border border-aico-border-subtle">
            {d.links.map((l, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3">
                <Icon name="link" size={16} className="text-aico-muted" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium">{l.title}</div>
                  {l.description && <div className="truncate text-[12.5px] text-aico-muted">{l.description}</div>}
                </div>
                <button className="btn-ghost btn-sm" onClick={() => void runAction({ type: 'browse', url: l.url }, plugin.manifest.id)}><Icon name="globe" size={14} />Open here</button>
                <button className="btn-ghost btn-sm" onClick={() => void desktop.shell.openExternal(l.url)}><Icon name="external" size={14} /></button>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }
  // frame
  if (!trusted) return <TrustGate pluginId={plugin.manifest.id} name={plugin.manifest.name} />;
  return <PluginFrame pluginId={plugin.manifest.id} entry={d.entry} title={d.title} />;
}

export function TrustGate({ pluginId, name }: { pluginId: string; name: string }): React.ReactElement {
  const prefs = useDesk(s => s.prefs);
  const setPrefs = useDesk(s => s.setPrefs);
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="card max-w-md p-6 text-center">
        <Icon name="shield" size={28} className="mx-auto text-aico-warning" />
        <h2 className="mt-3 text-[16px] font-semibold">Run “{name}”?</h2>
        <p className="mt-2 text-[13px] text-aico-secondary">
          This plugin draws its page with its own script. It runs in a sandbox with no access to your files,
          the engine or your chats — it can only ask the app to do a few things, and you see each one.
        </p>
        <div className="mt-4 flex justify-center gap-2">
          <button className="btn-primary" onClick={() => void setPrefs({ plugins: { ...prefs.plugins, trusted: [...prefs.plugins.trusted, pluginId] } })}>Trust and run</button>
        </div>
      </div>
    </div>
  );
}

export function PluginFrame({ pluginId, entry, title, height, payload }: {
  pluginId: string; entry: string; title: string; height?: number; payload?: unknown;
}): React.ReactElement {
  const ref = useRef<HTMLIFrameElement>(null);
  const mode = useDesk(s => s.mode);
  useEffect(() => {
    const onMsg = (e: MessageEvent): void => {
      if (e.source !== ref.current?.contentWindow) return;
      void handleFrameMessage(pluginId, e.data, (reply) => ref.current?.contentWindow?.postMessage(reply, '*'));
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [pluginId]);
  const post = (): void => {
    const vars: Record<string, string> = {};
    const st = document.documentElement.style;
    for (let i = 0; i < st.length; i++) { const k = st.item(i); if (k.startsWith('--')) vars[k] = st.getPropertyValue(k); }
    ref.current?.contentWindow?.postMessage({ type: 'aico:init', theme: { mode, vars }, payload }, '*');
  };
  useEffect(() => { post(); });
  return (
    <iframe
      ref={ref}
      title={title}
      src={`aico://app/plugins/${pluginId}/${entry}`}
      sandbox="allow-scripts allow-forms allow-popups"
      onLoad={post}
      className="w-full flex-1 border-0 bg-transparent"
      style={height ? { height, flex: 'none' } : undefined}
    />
  );
}
