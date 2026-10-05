/**
 * The desktop's Code map page (ADR 0028): the shared view
 * (web/components/codegraph) with the desktop's own hands — files open in the
 * editor, "Ask AICO about this" starts a chat in the project with the context
 * already in the composer.
 *
 * Route: `codemap` with `path` (the project; the chat's project when absent),
 * optional `file` (select it) and `mode`. The agent reaches it with
 * `ide_navigate {view: "codemap", params: {path, file}}`; people from the
 * project page, the file explorer's context menu and the command palette.
 *
 * @module desktop/renderer/pages/CodeMapPage
 */

import React from 'react';
import { useStore } from '@web/store';
import { CodeGraphView } from '@web/components/codegraph/CodeGraphView';
import { MODES, type Mode } from '@web/components/codegraph/model';
import { go } from '@/state/desk';
import { newChat } from '@/chat/actions';
import { basename } from '@/lib/util';
import type { ViewProps } from '@/plugins/registry';

export function CodeMapPage({ params }: ViewProps): React.ReactElement {
  const fallback = useStore(s => s.project);
  const projects = useStore(s => s.projects);
  const path = params?.path || fallback || '';
  const project = projects.find(p => p.path === path);
  const mode = MODES.some(m => m.id === params?.mode) ? params!.mode as Mode : undefined;

  if (!path) {
    return <div className="flex flex-1 items-center justify-center text-aico-muted">Open a project to see its code map.</div>;
  }
  return (
    <CodeGraphMount
      key={path}
      path={path}
      name={project?.name ?? basename(path)}
      {...(params?.file ? { file: params.file } : {})}
      {...(mode ? { mode } : {})}
    />
  );
}

/** The view, mounted for one project. Exported for the project page's tab. */
export function CodeGraphMount({ path, name, file, mode }: { path: string; name: string; file?: string; mode?: Mode }): React.ReactElement {
  return (
    <CodeGraphView
      projectPath={path}
      projectName={name}
      {...(file ? { initialFile: file } : {})}
      {...(mode ? { initialMode: mode } : {})}
      host={{
        openFile: (rel, line) => go('files', { root: path, open: joinAbs(path, rel), ...(line ? { line: String(line) } : {}) }),
        ask: prompt => newChat({ project: path, prompt }),
      }}
    />
  );
}

/** The editor opens absolute paths, spelled with the project root's own separator. */
function joinAbs(root: string, rel: string): string {
  const sep = root.includes('\\') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${sep}${rel.split('/').join(sep)}`;
}
