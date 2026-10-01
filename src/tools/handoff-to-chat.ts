/**
 * `HandOffToChat` — the browser copilot's door to a full chat.
 *
 * The copilot is a browsing specialist in a small panel. When it is asked for
 * work that is not browsing (code, a project, a long build, server ops) it was
 * doing it anyway, in the panel, in the scratch workspace. This tool moves the
 * work to an ordinary chat session — new, or one the person names — seeded
 * with the task and a compact, guarded context block, and started; the
 * copilot then says in one line where it went, and the desktop shows a card
 * and a toast (server/chat-handoff.ts publishes it).
 *
 * A thin shell, like the editor's host tools: validate, ask whatever is driving
 * the run, report. The moving itself needs the server's run manager, so it is
 * reached through the run context (`RunContext.handOff`), which is set only for
 * the copilot's own turns. Everywhere else the tool is not offered at all
 * (agent.ts `resolveToolSet`) — a main chat handing work to another main chat
 * would be a loop with extra steps.
 *
 * The result ends with a machine-readable tag (shared/chat-handoff.ts
 * `handOffTag`), so the copilot draws its "Continued in chat" card from the
 * durable log and a reload still shows it.
 *
 * @module tools/handoff-to-chat
 */

import { currentRunContext, type HandOffRequest } from '../run-context.js';
import { handOffTag, HANDOFF_TOOL } from '../../shared/chat-handoff.js';

export const handOffToChatDefinition = {
  name: HANDOFF_TOOL,
  description:
    'Move work that is not browsing to a full AICO chat, and start it there: writing or fixing code, '
    + 'project or repo work, long multi-step builds, server operations, documents meant for a project. '
    + 'Creates a new chat (in `project`, or the copilot\'s own folder) seeded with `task` plus the page '
    + 'the user is on and your `notes`, starts its first turn, and shows the user where it went. '
    + 'Pass `chat` instead to send it to an existing chat by name ("my Asterxa chat" → "Asterxa"). '
    + 'Do not start the work yourself after handing it off — say in one line where it continues.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'What the chat should do, in the user\'s words — complete enough to act on without this conversation.' },
      notes: { type: 'string', description: 'What the chat needs from this page or conversation: the relevant extract, decisions already made. Short; page text is passed as data.' },
      project: { type: 'string', description: 'A project by name or absolute path, when the user named one. Omit for the default folder.' },
      title: { type: 'string', description: 'A short name for the new chat (≤ 8 words). Omit to name it from the task.' },
      chat: { type: 'string', description: 'Send to this existing chat (by title) instead of creating one.' },
      includePage: { type: 'boolean', description: 'Carry the current page (URL, title, selection) into the chat. Default true.' },
    },
    required: ['task'],
  },
};

export async function handOffToChat(input: Partial<HandOffRequest>): Promise<string> {
  const bridge = currentRunContext()?.handOff;
  if (!bridge) {
    throw new Error(`${HANDOFF_TOOL} is only available in the desktop browser's copilot. Do the work here instead.`);
  }
  const task = typeof input.task === 'string' ? input.task.trim() : '';
  if (!task) throw new Error('task is required: say what the chat should do, in the user\'s words.');
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const request: HandOffRequest = {
    task,
    ...(str(input.notes) ? { notes: str(input.notes)! } : {}),
    ...(str(input.project) ? { project: str(input.project)! } : {}),
    ...(str(input.title) ? { title: str(input.title)! } : {}),
    ...(str(input.chat) ? { chat: str(input.chat)! } : {}),
    ...(input.includePage === false ? { includePage: false } : {}),
  };
  const out = await bridge(request);
  if (!out.ok) {
    if (out.candidates?.length) {
      const list = out.candidates.map(c => `- "${c.title}"${c.project ? ` (${c.project})` : ''}`).join('\n');
      throw new Error(`${out.error}\n${list}\nAsk the user which one (AskUserQuestion), then call ${HANDOFF_TOOL} again with that exact title as chat.`);
    }
    throw new Error(out.error);
  }
  const where = out.existing
    ? `Sent to the existing chat "${out.title}"${out.queued ? ' (it was busy; this runs as its next turn)' : ''}.`
    : `Created the chat "${out.title}" in ${out.project} and started it.`;
  return [
    `${where} The work continues there; the user has been shown a link to it.`,
    'Tell the user in one line that it continues in that chat. Do not do the work here.',
    handOffTag({
      sessionId: out.sessionId, title: out.title, project: out.project,
      ...(out.existing ? { existing: true } : {}), ...(out.queued ? { queued: true } : {}),
    }),
  ].join('\n');
}
