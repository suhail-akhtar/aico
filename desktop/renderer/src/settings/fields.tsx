/**
 * Engine settings, drawn from the shared schema.
 *
 * `web/src/settings-schema.ts` describes every engine setting that has a
 * sensible control — its path, label, kind and default. The browser client
 * draws it one way; this draws it the desktop's way (Antigravity rows with a
 * control on the right). One schema, so a setting added to the engine appears
 * in both, and a secret path can never be written from either.
 *
 * Saves one leaf at a time through `POST /api/settings/path`.
 *
 * @module desktop/renderer/settings/fields
 */

import React, { useEffect, useState } from 'react';
import { api } from '@web/api';
import { useStore } from '@web/store';
import { readPath, type Field, type Pane } from '@web/settings-schema';
import { toast } from '@/state/desk';
import { cls } from '@/lib/util';

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }): React.ReactElement {
  return (
    <button role="switch" aria-checked={checked} aria-label={label} className={cls('switch', disabled && 'opacity-50')} disabled={disabled} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export function Row({ title, desc, children, stack }: { title: React.ReactNode; desc?: React.ReactNode; children?: React.ReactNode; stack?: boolean }): React.ReactElement {
  return (
    <div className={cls('set-row', stack && 'flex-col items-stretch')}>
      <div className="min-w-0 flex-1">
        <div className="set-title">{title}</div>
        {desc && <div className="set-desc">{desc}</div>}
      </div>
      {children && <div className={cls(stack ? 'mt-2' : 'shrink-0')}>{children}</div>}
    </div>
  );
}

export function EnginePane({ pane }: { pane: Pane }): React.ReactElement {
  const settings = useStore(s => s.settings) as Record<string, unknown>;
  const refresh = useStore(s => s.refreshSettings);
  useEffect(() => { void refresh(); }, [refresh]);
  return (
    <div>
      {pane.blurb && <p className="mb-4 text-[13px] text-aico-muted">{pane.blurb}</p>}
      {pane.groups.map(g => (
        <section key={g.title}>
          <h3 className="set-heading">{g.title}</h3>
          {g.hint && <p className="-mt-1 mb-2 text-[12px] text-aico-muted">{g.hint}</p>}
          <div className="set-group">
            {g.fields.map(f => <FieldRow key={f.path} field={f} value={readPath(settings, f.path)} onSaved={refresh} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

function FieldRow({ field, value, onSaved }: { field: Field; value: unknown; onSaved: () => Promise<void> }): React.ReactElement {
  const [draft, setDraft] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const shown = value === undefined ? field.fallback : value;

  useEffect(() => {
    if (field.kind === 'number') setDraft(value === undefined ? '' : String(Number(value) / (field.scale ?? 1)));
    else if (field.kind === 'text') setDraft(value === undefined ? '' : String(value));
    else if (field.kind === 'list') setDraft(Array.isArray(value) ? value.join(', ') : '');
  }, [value, field]);

  const save = async (v: unknown): Promise<void> => {
    setSaving(true);
    setError(null);
    try { await api.saveSettingPath(field.path, v); await onSaved(); }
    catch (err) { setError((err as Error).message); toast.error(`Could not save ${field.label}`, (err as Error).message); }
    finally { setSaving(false); }
  };

  let control: React.ReactNode = null;
  switch (field.kind) {
    case 'toggle':
      control = <Switch checked={Boolean(shown)} label={field.label} onChange={v => void save(v)} disabled={saving} />;
      break;
    case 'segmented':
      control = (
        <div className="segmented">
          {field.options!.map(o => (
            <button key={o.value} aria-pressed={String(shown) === o.value} onClick={() => void save(o.value)} title={o.hint}>{o.label}</button>
          ))}
        </div>
      );
      break;
    case 'select':
      control = (
        <select className="select w-56" value={shown === undefined ? '' : String(shown)} onChange={e => void save(e.target.value || undefined)}>
          {field.fallback === undefined && <option value="">Default</option>}
          {field.options!.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
      break;
    case 'number':
      control = (
        <div className="flex items-center gap-1.5">
          <input className="input w-28 text-right tabular-nums" inputMode="decimal" value={draft}
            placeholder={field.fallback !== undefined ? String(Number(field.fallback) / (field.scale ?? 1)) : 'default'}
            onChange={e => setDraft(e.target.value)}
            onBlur={() => {
              if (draft.trim() === '') { if (value !== undefined) void save(undefined); return; }
              const n = Number(draft);
              if (!Number.isFinite(n)) { setError('Numbers only — not saved'); return; }
              if (field.min !== undefined && n < field.min) { setError(`At least ${field.min}`); return; }
              if (field.max !== undefined && n > field.max) { setError(`At most ${field.max}`); return; }
              const stored = n * (field.scale ?? 1);
              if (stored !== value) void save(stored);
            }} />
          {field.unit && <span className="text-[12px] text-aico-muted">{field.unit}</span>}
        </div>
      );
      break;
    case 'text':
      control = (
        <input className="input w-72" value={draft} placeholder={field.placeholder ?? (field.fallback !== undefined ? String(field.fallback) : '')}
          onChange={e => setDraft(e.target.value)} onBlur={() => { const v = draft.trim(); if ((v || undefined) !== value) void save(v || undefined); }} />
      );
      break;
    case 'list':
      control = (
        <input className="input w-72" value={draft} placeholder={field.fallbackList?.join(', ') ?? field.placeholder ?? 'comma, separated'}
          onChange={e => setDraft(e.target.value)} onBlur={() => {
            const items = draft.split(',').map(s => s.trim()).filter(Boolean);
            if (field.numeric && items.some(i => !Number.isFinite(Number(i)))) { setError('Numbers only — not saved'); return; }
            const next = items.length ? (field.numeric ? items.map(Number) : items) : undefined;
            if (JSON.stringify(next) !== JSON.stringify(value)) void save(next);
          }} />
      );
      break;
  }
  return (
    <Row title={<>{field.label}{value !== undefined && <span className="ml-2 text-[11px] font-normal text-aico-accent">changed</span>}</>}
      desc={<>{field.hint}{error && <span className="ml-1 text-aico-danger">{error}</span>}</>}>
      {control}
    </Row>
  );
}
