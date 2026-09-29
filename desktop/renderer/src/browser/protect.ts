/**
 * When protected browsing flags a page, the agents come to help: with "Let
 * AICO check suspicious pages automatically" on (the default), the copilot
 * opens beside the page and is asked to explain the warning — once per page,
 * and only when the browser is on screen (otherwise a notice offers it).
 *
 * The request is look-only by wording, and by enforcement: main refuses every
 * click / type / fill on a flagged page (electron/browser-privacy.ts).
 *
 * @module desktop/renderer/browser/protect
 */

import { on } from '@/desktop';
import { go, useDesk } from '@/state/desk';
import type { ThreatEvent, ThreatInfo } from '@desk/browser-types';
import { askCopilot } from './Copilot';
import { copilotSurface, prefillCopilot, toggleCopilot } from './copilot-ui';
import { useCopilot } from './copilot-session';

/** Pages already explained this session (tab + URL), so a reload does not ask twice. */
const asked = new Set<string>();

function promptFor(threat: ThreatInfo, prompt?: string): string {
  if (prompt) return prompt;
  return [
    `AICO Protected Browsing flagged this page as ${threat.level === 'block' ? 'likely deceptive' : 'possibly suspicious'}: ${threat.url}`,
    'Signals found on this device:',
    ...threat.reasons.slice(0, 6).map(r => `- ${r.label}`),
    '',
    'Explain in plain words why this looks suspicious (or why it may be a false alarm), who it may be imitating, and what I should do next.',
    'Only look — do NOT click, type, fill, submit or download anything on it, and never ask me to enter a password, card or code there.',
  ].join('\n');
}

/** Open the copilot and ask it about a flagged page (from the warning page or bar, or automatically). */
export async function explainThreat(tabId: string, threat: ThreatInfo, prompt?: string): Promise<void> {
  asked.add(`${tabId} ${threat.url}`);
  const text = promptFor(threat, prompt);
  // Mid-answer, a second message would interrupt it: put the question in the box instead.
  if (useCopilot.getState().busy) { prefillCopilot(text); return; }
  toggleCopilot(true);
  await askCopilot(text).catch(() => prefillCopilot(text));
}

let installed = false;

export function installProtect(): void {
  // Only the main window asks; the floating copilot's own window shares the store but must not ask twice.
  if (installed || copilotSurface() === 'overlay') return;
  installed = true;
  on<ThreatEvent>('browser:threat', (e) => {
    if (!e?.threat) return;
    const key = `${e.tabId} ${e.threat.url}`;
    if (asked.has(key)) return;
    const d = useDesk.getState();
    const onScreen = d.route.view === 'browser';
    if (e.autoCheck && onScreen) { void explainThreat(e.tabId, e.threat, e.prompt); return; }
    asked.add(key);
    d.toast({
      kind: 'warning', ttl: 15_000,
      title: e.threat.level === 'block' ? 'AICO blocked a deceptive page' : 'AICO flagged a suspicious page',
      body: `${e.threat.host} — ${e.threat.reasons[0]?.label ?? 'it looks deceptive'}`,
      action: { label: e.autoCheck ? 'Show and explain' : 'Show', run: () => { go('browser'); if (e.autoCheck) void explainThreat(e.tabId, e.threat, e.prompt); } },
    });
  });
}
