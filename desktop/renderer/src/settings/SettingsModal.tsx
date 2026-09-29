/**
 * Settings — Antigravity's layout: a modal with a section list on the left
 * (the app, the agent, integrations, then each project) and one section on the
 * right. Sections are contributed by plugins, the built-in ones included, so a
 * plugin that is switched off takes its settings with it.
 *
 * @module desktop/renderer/settings/SettingsModal
 */

import React, { useMemo, useState } from 'react';
import { useStore } from '@web/store';
import { useProjects } from '@/lib/projects';
import { useDesk } from '@/state/desk';
import { useSettingsSections } from '@/plugins/registry';
import { Icon } from '@/lib/icons';
import { cls, initials } from '@/lib/util';
import { Modal } from '@/shell/Modal';
import { useLocal } from '@/lib/local';
import { ProjectSettingsSection } from './sections/ProjectSettings';

const GROUP_LABEL: Record<string, string> = { app: 'Settings', agent: 'Agent', integrations: 'Integrations' };

export function SettingsModal(): React.ReactElement | null {
  const section = useDesk(s => s.settings);
  const open = useDesk(s => s.openSettings);
  const close = useDesk(s => s.closeSettings);
  const sections = useSettingsSections();
  const projects = useProjects();
  const info = useDesk(s => s.info);
  const [q, setQ] = useState('');
  // Many projects pushed everything else off the list; folded by default, remembered.
  const [projectsOpen, setProjectsOpen] = useLocal('desk.settings.projectsOpen', false);

  const grouped = useMemo(() => {
    const g: Record<string, typeof sections> = { app: [], agent: [], integrations: [] };
    for (const s of sections) (g[s.group ?? 'app'] ??= []).push(s);
    return g;
  }, [sections]);

  if (section === null) return null;
  const projectPath = section.startsWith('project:') ? section.slice('project:'.length) : null;
  const current = sections.find(s => s.id === section) ?? (projectPath ? null : sections[0]);
  const needle = q.trim().toLowerCase();

  return (
    <Modal open onClose={close} width="min(1180px, 94vw)" hideClose className="h-[86vh]">
      <div className="flex min-h-0 flex-1">
        <nav className="thin-scroll flex w-[240px] shrink-0 flex-col overflow-y-auto border-r border-aico-border-subtle bg-aico-sidebar px-3 pb-3 pt-4" aria-label="Settings sections">
          <input className="input mb-3 h-8 py-0 text-[12.5px]" placeholder="Search settings" value={q} onChange={e => setQ(e.target.value)} aria-label="Search settings" />
          {(['app', 'agent', 'integrations'] as const).map(g => {
            const items = grouped[g]!.filter(s => !needle || s.title.toLowerCase().includes(needle) || s.id.includes(needle));
            if (!items.length) return null;
            return (
              <div key={g} className="mb-2">
                <div className="px-2.5 pb-1 pt-2 text-[12px] text-aico-muted">{GROUP_LABEL[g]}</div>
                {items.map(s => (
                  <button key={s.id} className={cls('nav-item py-1.5 text-[13.5px]', current?.id === s.id && 'nav-item-active')} onClick={() => open(s.id)}>
                    {s.icon && <Icon name={s.icon} size={15} className="text-aico-secondary" />}{s.title}
                  </button>
                ))}
              </div>
            );
          })}
          {projects.some(p => !p.isWorkspace && (!needle || p.name.toLowerCase().includes(needle))) && (
            <div className="mb-2">
              <button className="flex w-full items-center gap-1 rounded-md px-2.5 pb-1 pt-2 text-left text-[12px] text-aico-muted hover:text-aico-primary"
                onClick={() => setProjectsOpen(o => !o)} aria-expanded={projectsOpen || Boolean(needle)}>
                <span className="flex-1">Projects <span className="tabular-nums">· {projects.filter(p => !p.isWorkspace).length}</span></span>
                <Icon name={projectsOpen || needle ? 'chevron-down' : 'chevron-right'} size={13} />
              </button>
              {(projectsOpen || Boolean(needle) || Boolean(projectPath)) && projects.filter(p => !p.isWorkspace && (!needle || p.name.toLowerCase().includes(needle)) && (projectsOpen || needle || p.path === projectPath)).map(p => (
                <button key={p.path} className={cls('nav-item py-1.5 text-[13.5px]', projectPath === p.path && 'nav-item-active')} onClick={() => open(`project:${p.path}`)} title={p.path}>
                  <Icon name="folder" size={15} className="text-aico-secondary" /><span className="truncate">{p.name}</span>
                </button>
              ))}
            </div>
          )}
          <div className="flex-1" />
          <div className="mt-3 flex items-center gap-2.5 border-t border-aico-border-subtle px-1 pt-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-aico-accent-soft text-[12px] font-semibold text-aico-accent">{initials(info?.user ?? 'You')}</span>
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium">{info?.user}</div>
              <div className="truncate text-[11.5px] text-aico-muted">{info?.hostname}</div>
            </div>
          </div>
        </nav>
        <div className="relative min-w-0 flex-1 overflow-y-auto">
          <button className="icon-btn absolute right-4 top-4 z-10" onClick={close} aria-label="Close settings"><Icon name="x" size={18} /></button>
          <div className="mx-auto max-w-[760px] px-10 pb-12 pt-8">
            {projectPath ? (
              <ProjectSettingsSection path={projectPath} />
            ) : current ? (
              <>
                <h1 className="text-[22px] font-semibold tracking-tight">{current.title}</h1>
                <div className="mt-5"><current.component /></div>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </Modal>
  );
}
