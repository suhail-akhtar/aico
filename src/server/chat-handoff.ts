/**
 * Moving work from the browser copilot into a full chat, and starting it.
 *
 * The copilot (desktop browser panel) is a browsing specialist; code, project
 * work, long builds and server ops belong in an ordinary chat with the main
 * chat's panels and the person's project. `HandOffToChat`
 * (tools/handoff-to-chat.ts) and the copilot's "Hand off to chat" button
 * (`POST /api/chat/handoff`) both land here, so a forced hand-off and a
 * model-decided one do exactly the same thing:
 *
 *   1. pick the target — a chat the person named (matched by title; several
 *      matches go back as a question, never a guess), or a new chat in the
 *      project named, else the copilot's own folder;
 *   2. seed it — the task first, then a compact context block (the page from
 *      the copilot's latest `<browser-context>` header, the copilot's notes),
 *      page text through the injection guard (shared/chat-handoff.ts);
 *   3. start it — a new turn, or a queued follow-up when that chat is busy;
 *   4. announce it — on the `chat-handoff` topic, which the desktop's main
 *      window turns into a toast with Open (the copilot draws its own card
 *      from the tool result, so it survives a reload).
 *
 * Everything that needs the server's state comes in as `HandOffDeps`, so the
 * decisions are tested offline with fakes (test-harness.mjs) and the server
 * wires the real run manager in one place.
 *
 * Deliberately not done: inheriting the copilot's model (the chat runs on the
 * person's default, as a chat they started would), or copying the copilot's
 * transcript (the notes carry what matters; a browsing transcript is noise in
 * a coding chat's context).
 *
 * @module server/chat-handoff
 */

import type { HandOffOutcome, HandOffRequest } from '../run-context.js';
import {
  buildHandOffMessage, handOffTitle, latestPage, matchChat,
  type ChatRow, type HandOffPage,
} from '../../shared/chat-handoff.js';

export interface HandOffDeps {
  /** Every chat the sidebar would list, with its current title. */
  listChats(): Promise<ChatRow[]>;
  /** Known projects, for naming one. */
  listProjects(): Promise<Array<{ path: string; name?: string }>>;
  /** The copilot session's folder and user messages (newest last), when it is open. */
  source(sessionId: string): { cwd: string; title?: string; userMessages: string[] } | undefined;
  /** Register a folder as a project (an absolute path the person named). */
  addProject(dir: string): Promise<string | undefined>;
  /** Open the chat in `cwd`, name it (new chats only) and start or queue `message`. */
  start(sessionId: string, cwd: string, message: string, opts: { title?: string; existing: boolean }): Promise<'started' | 'queued'>;
  /** Tell the windows. */
  announce(event: { sessionId: string; title: string; project: string; existing: boolean; queued: boolean; from?: string }): void;
  newSessionId(): string;
}

/** A request from the button carries the page it is on; one from the tool reads it from the log. */
export type HandOffInput = HandOffRequest & { page?: HandOffPage | null };

const isAbsolute = (p: string): boolean => /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(p);
const norm = (p: string): string => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
const base = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;

/** Which known project a name or path means. */
async function resolveProject(deps: HandOffDeps, wanted: string): Promise<{ path: string } | { error: string }> {
  const projects = await deps.listProjects();
  const want = wanted.trim();
  const byPath = projects.find(p => norm(p.path) === norm(want));
  if (byPath) return { path: byPath.path };
  const lower = want.toLowerCase();
  const byName = projects.filter(p => (p.name ?? '').toLowerCase() === lower || base(p.path).toLowerCase() === lower);
  if (byName.length === 1) return { path: byName[0]!.path };
  if (isAbsolute(want)) {
    const added = await deps.addProject(want).catch(() => undefined);
    if (added) return { path: added };
    return { error: `Could not open "${want}" as a project (it may not exist). Omit project to use the default folder, or ask the user for the right path.` };
  }
  const names = projects.slice(0, 12).map(p => p.name || base(p.path)).join(', ');
  return { error: `No project is called "${want}"${byName.length > 1 ? ' unambiguously' : ''}. Known projects: ${names || '(none)'}. Pass one of those, an absolute path, or omit project to use the default folder.` };
}

export async function handOffToChat(deps: HandOffDeps, fromSessionId: string | undefined, req: HandOffInput): Promise<HandOffOutcome> {
  const task = req.task?.trim();
  if (!task) return { ok: false, error: 'task is required.' };
  const source = fromSessionId ? deps.source(fromSessionId) : undefined;

  const page = req.includePage === false ? null
    : req.page !== undefined ? req.page
      : source ? latestPage(source.userMessages) : null;
  const message = buildHandOffMessage({
    task, page,
    ...(req.notes ? { notes: req.notes } : {}),
    ...(source?.title ? { from: { title: source.title } } : {}),
  });

  // An existing chat, by name.
  if (req.chat?.trim()) {
    const rows = (await deps.listChats()).filter(r => r.id !== fromSessionId);
    const found = matchChat(rows, req.chat);
    if (found.kind === 'none') {
      return { ok: false, error: `No chat matches "${req.chat}". Ask the user which chat they mean, or omit chat to start a new one.` };
    }
    if (found.kind === 'ambiguous') {
      return {
        ok: false, error: `"${req.chat}" matches ${found.chats.length} chats.`,
        candidates: found.chats.map(c => ({ title: c.title ?? c.id, ...(c.project ? { project: c.project } : {}) })),
      };
    }
    const chat = found.chat;
    const cwd = chat.project ?? source?.cwd;
    if (!cwd) return { ok: false, error: `Could not tell which folder "${chat.title}" is in.` };
    const how = await deps.start(chat.id, cwd, message, { existing: true });
    const out = { sessionId: chat.id, title: chat.title ?? chat.id, project: cwd, existing: true, queued: how === 'queued' };
    deps.announce({ ...out, ...(fromSessionId ? { from: fromSessionId } : {}) });
    return { ok: true, ...out };
  }

  // A new chat, in the project named or the copilot's own folder.
  let cwd = source?.cwd;
  if (req.project?.trim()) {
    const picked = await resolveProject(deps, req.project);
    if ('error' in picked) return { ok: false, error: picked.error };
    cwd = picked.path;
  }
  if (!cwd) {
    const projects = await deps.listProjects();
    cwd = projects[0]?.path;
  }
  if (!cwd) return { ok: false, error: 'There is no project to start the chat in. Ask the user to open a folder first.' };

  const sessionId = deps.newSessionId();
  const title = handOffTitle(task, req.title);
  const how = await deps.start(sessionId, cwd, message, { title, existing: false });
  const out = { sessionId, title, project: cwd, existing: false, queued: how === 'queued' };
  deps.announce({ ...out, ...(fromSessionId ? { from: fromSessionId } : {}) });
  return { ok: true, ...out };
}

/** A chat id in the same shape the clients mint (web/src/session-memory.ts). */
export function mintSessionId(now = Date.now(), random = Math.random): string {
  return `web-${now.toString(36)}-${random().toString(36).slice(2, 8)}`;
}
