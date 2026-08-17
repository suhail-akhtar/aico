/**
 * Add or edit one provider, inline.
 *
 * The four fields, in the order they are asked for, because each one narrows
 * the next:
 *
 *   1. **Type** — which adapter drives it. Choosing this fills in the endpoint
 *      and the default model, so the rest of the form starts correct rather
 *      than empty.
 *   2. **Name** — what you call it. Two OpenAI accounts are only
 *      distinguishable by this, so it is a real field and not a nicety.
 *   3. **API key** — write-only. Never sent back by the server, so on an edit
 *      the field is blank and blank means "leave it alone".
 *   4. **Endpoint** — prefilled from the type, editable for a proxy, a
 *      self-hosted server, or a region. Required, and only required, for the
 *      OpenAI-compatible type, which has no default to fall back on.
 *
 * Testing happens **before** saving, against exactly what is typed. That is the
 * whole point of the test button: the first sign of a wrong key should not be a
 * failed turn several minutes later carrying an error from inside a provider
 * SDK.
 *
 * This used to be a modal over the settings screen. It is inline now because a
 * dialog stacked on a dialog gives you two close buttons, two Escape targets
 * and a backdrop over a backdrop, for a form whose whole context — the other
 * providers, which one is active — is the thing it was covering up.
 *
 * @module components/settings/ProviderEditor
 */

import React, { useEffect, useMemo, useState } from 'react';
import { api, type ProviderInstance, type ProviderTypeInfo } from '../../api';
import { Icon } from '../Icon';

export interface ProviderEditorProps {
  types: ProviderTypeInfo[];
  /** The instance being edited, or undefined to create one. */
  editing?: ProviderInstance;
  /** Ids already taken, for the duplicate check and the suggested id. */
  takenIds: string[];
  onClose: () => void;
  onSaved: () => void;
}

interface TestState {
  running: boolean;
  ok?: boolean;
  message?: string;
  models?: string[];
  latencyMs?: number;
}

export function ProviderEditor({
  types, editing, takenIds, onClose, onSaved,
}: ProviderEditorProps): React.ReactElement {
  const isNew = !editing;
  const [type, setType] = useState<ProviderInstance['type']>(editing?.type ?? 'openai');
  const [id, setId] = useState(editing?.id ?? '');
  const [name, setName] = useState(editing?.name ?? '');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(editing?.baseUrl ?? '');
  const [defaultModel, setDefaultModel] = useState(editing?.defaultModel ?? '');
  const [models, setModels] = useState<string[]>(editing?.models ?? []);
  const [advanced, setAdvanced] = useState(false);

  /**
   * Fields the user has actually edited.
   *
   * Switching the provider type has to re-seed the fields the type owns — a
   * gateway keeping `https://api.openai.com/v1` and `gpt-4o-mini` from a
   * previously selected type is worse than useless, it is wrong in a way that
   * looks right. But it must not clobber something deliberately typed. The only
   * way to tell those apart is to remember which is which.
   */
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const markTouched = (field: string): void =>
    setTouched(current => (current.has(field) ? current : new Set(current).add(field)));

  const [test, setTest] = useState<TestState>({ running: false });
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const info = useMemo(() => types.find(t => t.type === type), [types, type]);

  // Re-seed everything the type owns and the user has not edited. Clearing a
  // stale value is as important as filling a new one: an OpenAI-compatible
  // provider has no default endpoint, so the field must end up empty rather
  // than holding the last type's URL.
  useEffect(() => {
    if (!info || !isNew) return;
    if (!touched.has('name')) setName(info.label);
    if (!touched.has('baseUrl')) setBaseUrl(info.defaultBaseUrl);
    if (!touched.has('defaultModel')) { setDefaultModel(info.defaultModel); setModels([]); }
    if (!touched.has('id')) setId(suggestId(info.type, takenIds));
    // A test result belongs to the endpoint that produced it.
    setTest({ running: false });
    // `touched` is read but deliberately not a dependency: adding it would
    // re-run this the moment a field is first edited, undoing that edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, isNew, takenIds]);

  const runTest = async (): Promise<void> => {
    setTest({ running: true });
    try {
      const result = await api.testProviderDraft({
        type,
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      });
      setTest({
        running: false,
        ok: result.ok,
        message: result.error ?? (result.models?.length
          ? `Connected — ${result.models.length} models available`
          : 'Connected, but this key has no models'),
        ...(result.models ? { models: result.models } : {}),
        ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}),
      });
      // Adopting the discovered catalogue here is what makes the model picker
      // real rather than a hardcoded list.
      const found = result.models;
      if (found?.length) {
        setModels(found);
        setDefaultModel(current => (
          found.includes(current) ? current
          : info?.defaultModel && found.includes(info.defaultModel) ? info.defaultModel
          : found[0]!
        ));
      }
    } catch (err) {
      setTest({ running: false, ok: false, message: (err as Error).message });
    }
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setProblems([]);
    try {
      await api.saveProvider({
        id: id.trim(),
        type,
        name: name.trim(),
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(models.length ? { models } : {}),
        ...(defaultModel.trim() ? { defaultModel: defaultModel.trim() } : {}),
      });
      onSaved();
      onClose();
    } catch (err) {
      setProblems([(err as Error).message]);
    } finally {
      setSaving(false);
    }
  };

  const needsEndpoint = type === 'openai-compatible';
  const canSave = Boolean(id.trim() && name.trim() && (!needsEndpoint || baseUrl.trim()));

  return (
    <div className="rounded-xl border border-aico-border-subtle bg-aico-surface p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Labelled label="Provider" hint={info?.hint}>
          <select
            value={type}
            onChange={e => setType(e.target.value as ProviderInstance['type'])}
            disabled={!isNew}
            className={inputClass}
          >
            {types.map(t => <option key={t.type} value={t.type}>{t.label}</option>)}
          </select>
        </Labelled>

        <Labelled label="Display name">
          <input
            value={name}
            onChange={e => { setName(e.target.value); markTouched('name'); }}
            placeholder={info?.label ?? 'My provider'}
            className={inputClass}
          />
        </Labelled>
      </div>

      {info?.requiresKey !== false && (
        <div className="mt-4">
          <Labelled
            label="API key"
            hint={isNew
              ? (info?.envVar ? `Or leave blank to use ${info.envVar} from the environment` : undefined)
              : 'Leave blank to keep the stored key'}
          >
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder={editing?.keySource === 'settings' ? '•••••••••••• (stored)' : 'sk-…'}
              className={`${inputClass} font-mono`}
            />
          </Labelled>
        </div>
      )}

      {/* The endpoint and the id are correct by default for every named vendor.
          Folding them away keeps the common case to three fields, and opens
          automatically for the one type that cannot have a default. */}
      <button
        onClick={() => setAdvanced(v => !v)}
        className="mt-4 flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] text-aico-secondary
                   transition-colors hover:bg-aico-hover hover:text-aico-primary"
      >
        <Icon name={advanced || needsEndpoint ? 'chevron-down' : 'chevron-right'} size={13} />
        Endpoint and identity
      </button>

      {(advanced || needsEndpoint) && (
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Labelled
            label={needsEndpoint ? 'Endpoint (required)' : 'Endpoint'}
            hint={needsEndpoint
              ? 'The OpenAI-compatible API root, e.g. http://localhost:8000/v1'
              : 'Change only for a proxy, a region, or a self-hosted server'}
          >
            <input
              value={baseUrl}
              onChange={e => { setBaseUrl(e.target.value); markTouched('baseUrl'); }}
              placeholder={info?.defaultBaseUrl || 'https://…/v1'}
              spellCheck={false}
              className={`${inputClass} font-mono`}
            />
          </Labelled>

          <Labelled label="Id" hint={isNew ? 'Used in settings and logs' : 'Fixed once created'}>
            <input
              value={id}
              onChange={e => { setId(e.target.value.replace(/[^a-zA-Z0-9-_]/g, '')); markTouched('id'); }}
              disabled={!isNew}
              placeholder="work-openai"
              className={`${inputClass} font-mono`}
            />
          </Labelled>
        </div>
      )}

      <div className="mt-4">
        <Labelled
          label="Default model"
          hint={models.length ? `${models.length} from this endpoint` : 'Test the connection to load the catalogue'}
        >
          {models.length > 0 ? (
            <ModelChooser
              models={models}
              value={defaultModel}
              onPick={m => { setDefaultModel(m); markTouched('defaultModel'); }}
            />
          ) : (
            <input
              value={defaultModel}
              onChange={e => { setDefaultModel(e.target.value); markTouched('defaultModel'); }}
              placeholder={info?.defaultModel || 'model-id'}
              className={`${inputClass} font-mono`}
            />
          )}
        </Labelled>
      </div>

      {test.ok !== undefined && !test.running && <TestResult {...test} />}

      {problems.length > 0 && (
        <div className="mt-3 rounded-lg border border-aico-danger/40 bg-aico-danger/10 px-3 py-2
                        text-[12px] text-aico-danger">
          {problems.map(p => <div key={p}>{p}</div>)}
        </div>
      )}

      <div className="mt-4 flex items-center gap-2">
        <button
          onClick={() => void runTest()}
          disabled={test.running}
          className="flex items-center gap-1.5 rounded-full border border-aico-border-subtle px-3 py-1.5
                     text-[12px] text-aico-secondary transition-colors hover:bg-aico-hover
                     hover:text-aico-primary disabled:opacity-40"
        >
          <Icon name="bolt" size={13} />
          {test.running ? 'Testing…' : 'Test connection'}
        </button>
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="rounded-full px-3 py-1.5 text-[12px] text-aico-secondary
                     transition-colors hover:bg-aico-hover hover:text-aico-primary"
        >
          Cancel
        </button>
        <button
          onClick={() => void save()}
          disabled={!canSave || saving}
          className="rounded-full bg-aico-accent px-4 py-1.5 text-[12px] font-medium text-aico-on-accent
                     transition-colors hover:bg-aico-accent-hover disabled:opacity-40"
        >
          {saving ? 'Saving…' : isNew ? 'Add provider' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}

/**
 * Pick a model out of a catalogue that can be hundreds long.
 *
 * A filter box and a scrolling list rather than a `<select>`, because the real
 * catalogues here are 300+ entries of `vendor/family-version-variant` and the
 * question people arrive with is "which of these is the flash one" — a
 * substring away, and not answerable by scrolling.
 */
export function ModelChooser(
  { models, value, onPick }: { models: string[]; value: string; onPick: (model: string) => void },
): React.ReactElement {
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  const shown = needle ? models.filter(m => m.toLowerCase().includes(needle)) : models;

  return (
    <div className="rounded-lg border border-aico-border-subtle bg-aico-bg">
      <div className="flex items-center gap-2 border-b border-aico-border-subtle px-3 py-1.5">
        <Icon name="search" size={13} className="text-aico-muted" />
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder={`Filter ${models.length} models`}
          className="w-full bg-transparent py-0.5 text-[12px] text-aico-primary
                     placeholder:text-aico-muted focus:outline-none"
        />
      </div>
      <div className="max-h-44 overflow-y-auto p-1">
        {shown.length === 0 && (
          <p className="px-2 py-2 text-[12px] text-aico-muted">Nothing matches that.</p>
        )}
        {shown.map(model => (
          <button
            key={model}
            onClick={() => onPick(model)}
            className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-[12px]
                        transition-colors ${model === value
                          ? 'bg-aico-accent-soft text-aico-accent'
                          : 'text-aico-secondary hover:bg-aico-hover hover:text-aico-primary'}`}
          >
            <span className="w-3.5 shrink-0">
              {model === value && <Icon name="check" size={13} />}
            </span>
            <span className="min-w-0 truncate">{model}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function TestResult(
  { ok, message, latencyMs }: { ok?: boolean; message?: string; latencyMs?: number },
): React.ReactElement {
  return (
    <div
      className={`mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] ${ok
        ? 'border-aico-success/40 bg-aico-success/10 text-aico-success'
        : 'border-aico-danger/40 bg-aico-danger/10 text-aico-danger'}`}
    >
      <Icon name={ok ? 'check' : 'close'} size={14} className="mt-0.5" />
      <span className="flex-1 break-words">{message}</span>
      {latencyMs !== undefined && <span className="shrink-0 tabular-nums opacity-70">{latencyMs}ms</span>}
    </div>
  );
}

const inputClass =
  'w-full rounded-lg border border-aico-border-subtle bg-aico-bg px-3 py-2 text-[13px] text-aico-primary ' +
  'placeholder:text-aico-muted transition-colors focus:border-aico-accent/60 focus:outline-none ' +
  'disabled:opacity-60';

function Labelled(
  { label, hint, children }: { label: string; hint?: string; children: React.ReactNode },
): React.ReactElement {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium text-aico-secondary">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-aico-muted">{hint}</span>}
    </label>
  );
}

/** A readable id that does not collide: `openai`, then `openai-2`, and so on. */
export function suggestId(type: string, taken: string[]): string {
  if (!taken.includes(type)) return type;
  for (let n = 2; n < 100; n++) {
    const candidate = `${type}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return type;
}
