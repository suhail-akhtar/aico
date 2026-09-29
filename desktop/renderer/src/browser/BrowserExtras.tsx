/**
 * Small things beside the address bar that make the browser an AI browser:
 *
 *   - the page-kind chip ("✨ Product · $129") when AICO recognises what the
 *     page is — a click opens the copilot with the suggestions for it;
 *   - the autofill key, when the page has a form your saved details fit — a
 *     click fills it (choosing an address when there are several), never
 *     passwords, card numbers, CVVs or codes;
 *   - the full-view button.
 *
 * @module desktop/renderer/browser/BrowserExtras
 */

import React, { useEffect, useState } from 'react';
import { create } from 'zustand';
import { Icon } from '@/lib/icons';
import { cls } from '@/lib/util';
import { toast, useDesk } from '@/state/desk';
import { MenuItem, MenuSep, Popover } from '@/shell/Popover';
import { call } from './ipc';
import { toggleCopilot } from './copilot-ui';
import { usePageSignals, usePageSuggestions } from './useSuggestions';
import { toggleFullView, useFullView } from './fullview';

// ── Page kind ──

export function PageKindChip(): React.ReactElement | null {
  const { page, chips } = usePageSuggestions();
  if (page.kind === 'page' || chips.length === 0) return null;
  return (
    <button className="bx-kind-chip shrink-0" onClick={() => toggleCopilot(true)}
      title={`AICO sees a ${page.label.toLowerCase()} — ${chips.map(c => c.label).join(' · ')}`}>
      <Icon name="sparkles" size={12} />
      <span>{page.label}</span>
      {page.detail && <span className="text-aico-muted">· {page.detail}</span>}
    </button>
  );
}

// ── Autofill ──

interface AutofillStatus { encrypted: boolean; empty: boolean; addresses: Array<{ id: string; label: string }> }
interface FillResult { filled: number; fields: Array<{ label: string; what: string }>; skipped: Array<{ label: string; reason: string }>; empty?: boolean; address?: string }

/** The profile's summary, refreshed when the settings page saves it. */
export const useAutofillStatus = create<{ status: AutofillStatus | null; refresh: () => void }>((set) => ({
  status: null,
  refresh: () => { void call<AutofillStatus>('browser:autofill:status').then(s => set({ status: s ?? null })).catch(() => {}); },
}));

export async function fillFromProfile(addressId?: string): Promise<void> {
  try {
    const r = await call<FillResult>('browser:autofill:fill', addressId ? { addressId } : {});
    if (!r) { toast.info('Autofill is not available in this version'); return; }
    if (r.empty) { toast.info('No autofill profile yet', 'Add your details in Settings → Browser → Autofill.'); return; }
    const refused = r.skipped.filter(s => /never autofilled/.test(s.reason)).length;
    if (!r.filled) toast.info('Nothing to fill', refused ? 'The only fields here are ones AICO never fills (passwords, cards, codes).' : 'No field on this page matches your saved details.');
    else toast.success(`Filled ${r.filled} field${r.filled === 1 ? '' : 's'}${r.address ? ` · ${r.address}` : ''}`, refused ? `${refused} sensitive field${refused === 1 ? ' was' : 's were'} left for you.` : 'Check them before you submit.');
  } catch (err) { toast.error('Could not autofill', (err as Error).message); }
}

export function AutofillButton(): React.ReactElement | null {
  const signals = usePageSignals();
  const status = useAutofillStatus(s => s.status);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  // Re-read on each page: the profile may have changed in Settings (or from another window).
  useEffect(() => { useAutofillStatus.getState().refresh(); }, [signals?.url]);
  const fits = Boolean(signals && signals.fields.personal >= 1);
  if (!fits || !status || status.empty) return null;
  const many = status.addresses.length > 1;
  return (
    <>
      <button ref={setAnchor} className={cls('icon-btn-sm', open && 'bg-aico-hover')} aria-label="Autofill"
        onClick={() => (many ? setOpen(o => !o) : void fillFromProfile())}
        title="Fill this form with your saved details (never passwords, cards or codes)">
        <Icon name="key" size={15} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} placement="bottom-end" width={240}>
        {status.addresses.map(a => (
          <MenuItem key={a.id} icon="home" label={`Fill with “${a.label}”`} onClick={() => { setOpen(false); void fillFromProfile(a.id); }} />
        ))}
        <MenuSep />
        <MenuItem icon="settings" label="Manage autofill…" onClick={() => { setOpen(false); useDesk.getState().openSettings('browser'); }} />
      </Popover>
    </>
  );
}

// ── Full view ──

export function FullViewButton(): React.ReactElement {
  const on = useFullView(s => s.on);
  return (
    <button className={cls('icon-btn-sm', on && 'bg-aico-accent-soft text-aico-accent hover:text-aico-accent')} onClick={toggleFullView} aria-pressed={on}
      title={on ? 'Leave full view (Shift+F11)' : 'Full view — the browser fills the window (Shift+F11; F11 for full screen)'}>
      <Icon name={on ? 'collapse' : 'expand'} size={15} />
    </button>
  );
}
