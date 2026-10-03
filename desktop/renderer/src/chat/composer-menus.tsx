/**
 * What the composer's "/" and "@" menus offer.
 *
 * "/" lists the composer's own actions — plan first, how hard to think, how
 * much to ask, attachments, mentions, model, chat actions — then every plugin
 * command and prompt, so a plugin's contributions are one keystroke away
 * without the plugin doing anything extra.
 *
 * "@" lists the project's files and folders as you type (searched on disk by
 * the main process), the agents you can talk to directly, and pickers for
 * anything outside the project.
 *
 * @module desktop/renderer/chat/composer-menus
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useStore } from '@web/store';
import { api, type AgentSpec } from '@web/api';
import { go } from '@/state/desk';
import { invoke, isDesktop } from '@/desktop';
import { useCommands, usePrompts } from '@/plugins/registry';
import { exportChat, setSendOptions, useSendOptions, type SendOptions } from './actions';
import { dedupe, mentionPath, rankItems, type SuggestItem } from './suggest-core';

export { mentionPath };

export const EFFORTS: Array<[SendOptions['effort'], string]> = [
  ['auto', 'Auto'], ['off', 'Off'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max'],
];

/** The mirror behind the textarea: the same text, with each @mention wrapped so CSS can paint it. */
export function highlightMentions(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /(^|\s)(@(?:"[^"\n]+"|\S+))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index + m[1]!.length;
    parts.push(text.slice(last, start));
    parts.push(<mark key={start} className="composer-mention">{m[2]}</mark>);
    last = start + m[2]!.length;
  }
  parts.push(text.slice(last));
  // A trailing newline needs something after it, or the mirror is a line short.
  parts.push('​');
  return parts;
}

export function useSlashItems({ busy, hasChat, pickFiles, mentionFile, mentionFolder, insertText }: {
  busy: boolean;
  hasChat: boolean;
  pickFiles: (images?: boolean) => Promise<void>;
  mentionFile: () => Promise<void>;
  mentionFolder: () => Promise<void>;
  insertText: (t: string) => void;
}): SuggestItem[] {
  const commands = useCommands();
  const prompts = usePrompts();
  const opts = useSendOptions();
  return useMemo(() => {
    const st = (): ReturnType<typeof useStore.getState> => useStore.getState();
    const msg = 'This message';
    const items: SuggestItem[] = [
      {
        id: 'plan', group: msg, icon: 'list', title: opts.planMode ? 'Plan first — turn off' : 'Plan first', hint: 'propose, then act',
        keywords: 'plan mode approve', checked: opts.planMode,
        run: () => { setSendOptions({ planMode: !opts.planMode }); return opts.planMode ? 'Plan first is off' : 'Plan first is on'; },
      },
      ...EFFORTS.filter(([v]) => v !== 'xhigh').map(([v, l]): SuggestItem => ({
        id: `think-${v}`, group: msg, icon: 'think',
        title: v === 'auto' ? 'Think: automatic' : v === 'off' ? 'Think: off' : `Think: ${l.toLowerCase()}`,
        keywords: 'reasoning effort think harder', checked: opts.effort === v,
        run: () => { setSendOptions({ effort: v }); return v === 'off' ? 'Thinking is off' : v === 'auto' ? 'Thinking: automatic' : `Thinking: ${l}`; },
      })),
      { id: 'approve-full', group: msg, icon: 'zap', title: 'Full autonomy', hint: 'never stops to ask', keywords: 'approval permission autonomous', checked: opts.approval === 'full',
        run: () => { setSendOptions({ approval: 'full' }); return 'Full autonomy is on'; } },
      { id: 'approve-auto', group: msg, icon: 'zap', title: 'Auto-approve', hint: 'acts, you watch', keywords: 'approval permission', checked: opts.approval === 'auto',
        run: () => { setSendOptions({ approval: 'auto' }); return 'Auto-approve is on'; } },
      { id: 'approve-edits', group: msg, icon: 'edit', title: 'Ask before edits', keywords: 'approval permission', checked: opts.approval === 'edits',
        run: () => { setSendOptions({ approval: 'edits' }); return 'Will ask before edits'; } },
      { id: 'approve-ask', group: msg, icon: 'shield', title: 'Ask every time', keywords: 'approval permission', checked: opts.approval === 'ask',
        run: () => { setSendOptions({ approval: 'ask' }); return 'Will ask before every step'; } },
      { id: 'browser', group: msg, icon: 'globe', title: 'Use the built-in browser', keywords: 'web test qa', run: () => insertText('Use the built-in browser (browser_* tools) for this. ') },
      { id: 'visuals', group: msg, icon: 'chart', title: 'Answer with visuals', keywords: 'charts tables widgets', run: () => insertText('Show the answer with charts, tables and widgets where they help. ') },
      { id: 'attach', group: 'Add', icon: 'paperclip', title: 'Attach files…', keywords: 'upload', run: () => pickFiles() },
      { id: 'attach-img', group: 'Add', icon: 'image', title: 'Attach images…', keywords: 'upload picture screenshot', run: () => pickFiles(true) },
      { id: 'mention-file', group: 'Add', icon: 'at', title: 'Mention files…', keywords: '@ reference', run: () => mentionFile() },
      { id: 'mention-dir', group: 'Add', icon: 'folder', title: 'Mention a folder…', keywords: '@ reference directory', run: () => mentionFolder() },
      { id: 'model', group: 'Chat', icon: 'sparkles', title: 'Change model…', keywords: 'provider llm', run: () => { window.dispatchEvent(new Event('desk:open-model-picker')); } },
      { id: 'new', group: 'Chat', icon: 'new-chat', title: 'New chat', run: () => { st().newSession(); go('home'); return 'New chat started'; } },
    ];
    if (busy) items.push({ id: 'stop', group: 'Chat', icon: 'stop', title: 'Stop the running turn', run: async () => { await st().cancel(); return 'Stopped'; } });
    if (hasChat) {
      items.push(
        { id: 'branch', group: 'Chat', icon: 'git-branch', title: 'Branch into a new chat', run: async () => { await st().forkSession(st().sessionId); return 'Branched into a new chat'; } },
        { id: 'export-md', group: 'Chat', icon: 'download', title: 'Export chat as Markdown…', keywords: 'save', run: () => exportChat(st().sessionId, 'md', st().title) },
        { id: 'changes', group: 'Chat', icon: 'file-text', title: 'Review changes', keywords: 'diff', run: () => { go('changes', { id: st().sessionId }); } },
      );
    }
    // The composer's own entries above cover these builtins.
    const own = new Set(['chat.new', 'chat.planMode', 'chat.stop', 'chat.focus']);
    for (const c of commands) {
      if (own.has(c.id)) continue;
      items.push({
        id: `cmd:${c.id}`, group: c.category === 'Chat' || c.category === 'Agent' ? 'Chat' : 'Commands', icon: c.icon ?? 'zap', title: c.title,
        hint: c.keybinding, keywords: c.category, run: async () => { await c.run(); },
      });
    }
    for (const p of prompts) {
      items.push({ id: `prompt:${p.pluginId}:${p.id}`, group: 'Prompts', icon: p.icon ?? 'sparkles', title: p.title, keywords: p.prompt.slice(0, 120), run: () => insertText(p.prompt) });
    }
    return dedupe(items);
  }, [opts, busy, hasChat, commands, prompts, pickFiles, mentionFile, mentionFolder, insertText]);
}

/** Ids carry what a mention inserts: `file:<abs>`, `dir:<abs>`, `agent:<name>`, `browse-file:`, `browse-dir:`. */
export function useMentionItems(query: string | null, root: string | null): { items: SuggestItem[]; loading: boolean } {
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [agents, setAgents] = useState<AgentSpec[]>([]);
  const directChat = useStore(s => (s.settings as { agents?: { directChat?: boolean } }).agents?.directChat !== false);
  const active = query !== null;

  useEffect(() => {
    if (!active || !directChat) return;
    let live = true;
    api.agents().then(r => { if (live) setAgents(r.agents.filter(a => a.enabled)); }).catch(() => { /* a shortcut, not a requirement */ });
    return () => { live = false; };
  }, [active, directChat]);

  useEffect(() => {
    if (query === null || !root || !isDesktop) { setFiles([]); setLoading(false); return; }
    let live = true;
    setLoading(true);
    const t = setTimeout(() => {
      invoke<string[]>('fs:find', root, query.replace(/^"/, ''), 40)
        .then(r => { if (live) setFiles(r); })
        .catch(() => { if (live) setFiles([]); })
        .finally(() => { if (live) setLoading(false); });
    }, query ? 110 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [query, root]);

  const items = useMemo(() => {
    if (query === null) return [];
    const q = query.replace(/^"/, '').toLowerCase();
    const rootSlash = root ? root.replace(/\\/g, '/').replace(/\/+$/, '') : '';
    const out: SuggestItem[] = [];
    // Folders: the parents of the matching files, where the folder's own name matches.
    const dirs = new Set<string>();
    for (const f of files) {
      const rel = mentionPath(f, root).replace(/^"|"$/g, '').split('/');
      for (let i = 1; i < rel.length; i++) {
        if (!q || rel[i - 1]!.toLowerCase().includes(q)) dirs.add(rel.slice(0, i).join('/'));
      }
    }
    for (const f of files.slice(0, 30)) {
      const rel = mentionPath(f, root).replace(/^"|"$/g, '');
      const cut = rel.lastIndexOf('/');
      out.push({ id: `file:${f}`, group: 'Files', icon: 'file', title: cut >= 0 ? rel.slice(cut + 1) : rel, hint: cut >= 0 ? rel.slice(0, cut) : undefined, run: () => {} });
    }
    for (const d of [...dirs].slice(0, 8)) {
      const cut = d.lastIndexOf('/');
      out.push({ id: `dir:${rootSlash ? `${rootSlash}/${d}` : d}`, group: 'Folders', icon: 'folder', title: cut >= 0 ? d.slice(cut + 1) : d, hint: cut >= 0 ? d.slice(0, cut) : undefined, run: () => {} });
    }
    const ranked = rankItems(agents.map(a => ({ agent: a, title: a.name, keywords: `${a.role ?? ''} ${a.description ?? ''}` })), q);
    for (const { agent } of ranked.slice(0, 8)) {
      out.push({ id: `agent:${agent.name}`, group: 'Agents', icon: 'bot', title: `@${agent.name}`, hint: agent.role ?? agent.description?.slice(0, 60), run: () => {} });
    }
    out.push({ id: 'browse-file:', group: 'Anywhere', icon: 'file-plus', title: 'Pick files…', hint: 'on this computer', run: () => {} });
    out.push({ id: 'browse-dir:', group: 'Anywhere', icon: 'folder-plus', title: 'Pick a folder…', run: () => {} });
    return out;
  }, [query, files, agents, root]);

  return { items, loading };
}
