/**
 * Which model does which job (ADR 0017, engine `models/roles`).
 *
 * Before this page, nine features each picked a model their own way and
 * nothing showed which model, provider or price a job ran on — a typo in one
 * of them fell back to the work model without a word. So every row here is
 * the engine's own answer (`GET models/roles`), not a guess the client makes:
 * the model, where it is served, local or cloud, the price per million
 * tokens, where the choice came from (set here, an older setting, the preset)
 * and, when the first choice could not be used, why.
 *
 * Choices are written one path at a time to the person's own settings file
 * (`models.preset`, `models.localOnlyPersonal`, `models.roles.<role>`); an
 * empty box removes the entry and the preset decides again. A project's
 * settings cannot set any of this, so the page never needs to say whose file
 * won.
 *
 * Shared by the web settings (under Models) and the desktop's Models section.
 *
 * @module components/settings/RolesPane
 */

import React, { useCallback, useEffect, useState } from 'react';
import { api, type ModelRoleRow, type ModelRolesView } from '../../api';
import { useStore } from '../../store';

const PRESETS: Array<{ value: ModelRolesView['preset']; label: string; hint: string }> = [
  { value: 'balanced', label: 'Balanced (recommended)', hint: 'Today\'s behaviour: helpers on your model, background jobs on the cheap one.' },
  { value: 'economy', label: 'Economy', hint: 'Research and review helpers move to the cheap model too.' },
  { value: 'quality', label: 'Best quality', hint: 'Your main model for every job.' },
  { value: 'private', label: 'Private', hint: 'Jobs that read your own data stay on this machine.' },
];

const SOURCE_LABEL: Record<ModelRoleRow['source'], string> = {
  override: 'per call', role: 'set here', legacy: 'older setting', preset: 'preset', default: 'default', off: 'off',
};

/** `$0.25 / $1.25` per million tokens; a guessed price says so. */
export function formatRolePrice(price: ModelRoleRow['price']): string {
  if (!price) return '—';
  const f = (n: number): string => (n === 0 ? '$0' : n < 0.1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
  return `${f(price.input)} / ${f(price.output)}${price.known ? '' : ' (est.)'}`;
}

export function RolesPane(): React.ReactElement {
  const model = useStore(s => s.model ?? s.defaultModel);
  const refreshSettings = useStore(s => s.refreshSettings);
  const [view, setView] = useState<ModelRolesView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setView(await api.modelRoles(model ?? undefined)); setError(null); }
    catch (err) { setError((err as Error).message); }
  }, [model]);
  useEffect(() => { void load(); }, [load]);

  const save = async (path: string, value: unknown): Promise<void> => {
    try {
      await api.saveSettingPath(path, value);
      await Promise.all([load(), refreshSettings()]);
    } catch (err) { setError((err as Error).message); }
  };

  if (!view) {
    return <div className="text-[12px] text-aico-muted">{error ? `Could not load model roles: ${error}` : 'Loading model roles…'}</div>;
  }
  const localForced = view.preset === 'private';

  return (
    <section className="mt-8" data-model-roles>
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-aico-muted">Which model does which job</h4>
      <p className="mt-1 max-w-xl text-[12px] leading-relaxed text-aico-secondary">
        Your main model is <span className="font-mono">{view.mainModel || 'not set'}</span>. Everything else follows the preset
        unless you set a model for it here. Only your own settings choose these; a project cannot.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Model preset">
        {PRESETS.map(p => (
          <button
            key={p.value}
            role="radio"
            aria-checked={view.preset === p.value}
            onClick={() => void save('models.preset', p.value === 'balanced' ? null : p.value)}
            className={`rounded-xl border px-3 py-2 text-left transition-colors ${
              view.preset === p.value ? 'border-aico-accent bg-aico-accent-soft' : 'border-aico-border-subtle hover:bg-aico-hover'
            }`}
            data-preset={p.value}
          >
            <div className="text-[12.5px] font-medium text-aico-primary">{p.label}</div>
            <div className="mt-0.5 text-[11px] leading-snug text-aico-muted">{p.hint}</div>
          </button>
        ))}
      </div>

      <label className="mt-3 flex items-start gap-2 text-[12.5px] text-aico-primary">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={localForced || view.localOnlyPersonal}
          disabled={localForced}
          onChange={e => void save('models.localOnlyPersonal', e.target.checked ? true : null)}
          data-local-only
        />
        <span>
          Keep personal data on this machine
          <span className="block text-[11px] text-aico-muted">
            Background jobs and embeddings read your own sessions and memories. With this on they use only a local
            model (Ollama or a loopback endpoint); with none set they run without a model rather than go to the cloud.
            {localForced ? ' The Private preset turns this on.' : ''}
          </span>
        </span>
      </label>

      <datalist id="aico-role-models">
        {view.suggestions.map(m => <option key={m} value={m} />)}
      </datalist>

      <div className="mt-4 divide-y divide-aico-border-subtle rounded-xl border border-aico-border-subtle">
        {view.roles.map(row => (
          <RoleRow key={row.role} row={row} onSave={value => void save(`models.roles.${row.role}`, value)} />
        ))}
      </div>
      {error && <p className="mt-2 text-[12px] text-aico-danger">{error}</p>}
    </section>
  );
}

function RoleRow({ row, onSave }: { row: ModelRoleRow; onSave: (value: string | null) => void }): React.ReactElement {
  const [text, setText] = useState(row.chosen ?? '');
  useEffect(() => { setText(row.chosen ?? ''); }, [row.chosen]);
  const commit = (): void => {
    const next = text.trim();
    if (next === (row.chosen ?? '')) return;
    onSave(next ? next : null);
  };
  const warning = [row.fellBack, row.note].filter(Boolean).join(' ');

  return (
    <div className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_15rem]" data-role={row.role}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[13px] font-medium text-aico-primary">{row.label}</span>
          {row.personal && (
            <span className="rounded-full bg-aico-info/15 px-2 py-0.5 text-[10px] text-aico-info" title="Reads your own data beyond this conversation">personal</span>
          )}
          {row.model && (
            <span className={`rounded-full px-2 py-0.5 text-[10px] ${row.local ? 'bg-aico-success/15 text-aico-success' : 'bg-aico-elevated text-aico-secondary'}`}>
              {row.local ? 'local' : 'cloud'}
            </span>
          )}
          <span className="text-[10.5px] text-aico-muted">{SOURCE_LABEL[row.source]}</span>
        </div>
        <div className="mt-0.5 text-[11.5px] text-aico-secondary">{row.does}</div>
        <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-aico-muted">
          <span className="font-mono">{row.model || (row.ok ? '' : 'no model')}</span>
          {row.provider && <><span aria-hidden>·</span><span>{row.provider}</span></>}
          {row.price && <><span aria-hidden>·</span><span title="Input / output, per million tokens">{formatRolePrice(row.price)} per Mtok</span></>}
          {row.spent && <><span aria-hidden>·</span><span title="Since AICO started">${row.spent.usd.toFixed(4)} over {row.spent.calls} call{row.spent.calls === 1 ? '' : 's'}</span></>}
        </div>
        {warning && (
          <div className={`mt-1 text-[11px] ${row.ok ? 'text-aico-warning' : 'text-aico-danger'}`} data-role-warning>{warning}</div>
        )}
        {row.role === 'compact' && row.source === 'role' && (
          <div className="mt-1 text-[11px] text-aico-warning">A summary model other than Main cannot reuse the cached prompt, so each summary costs more.</div>
        )}
      </div>
      <div className="flex items-start gap-1.5">
        <input
          list="aico-role-models"
          value={text}
          onChange={e => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          placeholder={row.role === 'main' ? 'your chat model' : row.model ? `preset: ${row.model}` : row.fellBack ? 'none usable' : 'off'}
          disabled={row.role === 'main'}
          aria-label={`Model for ${row.label}`}
          className="w-full min-w-0 rounded-lg border border-aico-border-subtle bg-aico-bg px-2 py-1 font-mono text-[12px] text-aico-primary
                     placeholder:text-aico-muted focus:border-aico-accent focus:outline-none disabled:opacity-50"
        />
        {row.chosen && (
          <button
            onClick={() => { setText(''); onSave(null); }}
            className="rounded-full px-2 py-1 text-[11px] text-aico-muted hover:text-aico-primary"
            title="Back to the preset"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
