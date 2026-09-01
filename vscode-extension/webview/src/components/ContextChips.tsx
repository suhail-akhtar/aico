/**
 * What the next message will carry, shown before it is sent.
 *
 * The visibility *is* the feature. Copilot and Cursor both attach editor context
 * implicitly, and the failure mode is identical in both: the answer is about the
 * wrong file and there is no way to tell that from the conversation. A row of
 * chips costs 22px and makes that impossible.
 *
 * Every chip is removable, and a removal sticks. Chips are keyed by what they
 * refer to — a selection by its file *and* its line range — so dismissing the
 * context for one function does not silently suppress it for the next one
 * highlighted in the same file.
 *
 * @module components/ContextChips
 */

import React from 'react';
import {
  chipKey, reveal, type Attachments, type EditorContext,
} from '../context';

export function ContextChips({ editor, attached, onChange }: {
  editor: EditorContext;
  attached: Attachments;
  onChange: (next: Attachments) => void;
}): React.ReactElement | null {
  const dismiss = (key: string): void => {
    const dismissed = new Set(attached.dismissed);
    dismissed.add(key);
    onChange({ ...attached, dismissed });
  };

  const chips: React.ReactElement[] = [];

  if (editor.selection) {
    const s = editor.selection;
    const key = chipKey('sel', s.uri, `${s.fromLine}-${s.toLine}`);
    if (!attached.dismissed.has(key)) {
      const range = s.fromLine === s.toLine ? `${s.fromLine}` : `${s.fromLine}-${s.toLine}`;
      chips.push(
        <Chip
          key={key}
          icon="selection"
          label={`${base(s.path)}:${range}`}
          title={`${s.path}, lines ${range} — sent with your message`}
          onOpen={() => reveal(s.uri, s.fromLine)}
          onRemove={() => dismiss(key)}
        />,
      );
    }
  }

  if (editor.active) {
    const a = editor.active;
    const key = chipKey('file', a.uri);
    // Suppressed while a selection in the same file is attached: they would be
    // two chips saying the same thing, and the selection says more.
    const shadowed = editor.selection?.uri === a.uri
      && !attached.dismissed.has(chipKey('sel', a.uri, `${editor.selection.fromLine}-${editor.selection.toLine}`));
    if (!attached.dismissed.has(key) && !shadowed) {
      chips.push(
        <Chip
          key={key}
          icon="file"
          label={base(a.path)}
          title={`${a.path} — named in your message, not pasted into it`}
          onOpen={() => reveal(a.uri)}
          onRemove={() => dismiss(key)}
        />,
      );
    }
  }

  for (const pin of attached.pinned) {
    const key = chipKey('pin', pin.uri, pin.symbol ?? '');
    chips.push(
      <Chip
        key={key}
        icon={pin.symbol ? 'symbol' : 'file'}
        label={pin.symbol ?? base(pin.path)}
        title={pin.symbol ? `${pin.symbol} — ${pin.path}` : pin.path}
        onOpen={() => reveal(pin.uri, pin.line)}
        onRemove={() => onChange({
          ...attached,
          pinned: attached.pinned.filter(p => p !== pin),
        })}
      />,
    );
  }

  /*
    Problems are opt-in, and the chip is the opt-in.

    Attaching them by default would put a language server's entire opinion of a
    half-typed file into every message. Offered as a count, one click attaches
    them — which is the moment somebody actually wants them.
  */
  if (editor.problemTotal > 0) {
    const errors = editor.problems.filter(p => p.severity === 'error').length;
    chips.push(
      <Chip
        key="problems"
        icon="problem"
        tone={errors > 0 ? 'danger' : 'warning'}
        active={attached.problems}
        label={`${editor.problemTotal} problem${editor.problemTotal === 1 ? '' : 's'}`}
        title={attached.problems
          ? 'Attached — the messages ride with your next message'
          : 'Click to send these with your next message'}
        onOpen={() => onChange({ ...attached, problems: !attached.problems })}
        onRemove={attached.problems
          ? () => onChange({ ...attached, problems: false })
          : undefined}
      />,
    );
  }

  if (chips.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1 px-1 pb-1.5">
      {chips}
    </div>
  );
}

function Chip({ icon, label, title, tone, active, onOpen, onRemove }: {
  icon: 'file' | 'selection' | 'symbol' | 'problem';
  label: string;
  title: string;
  tone?: 'danger' | 'warning';
  active?: boolean;
  onOpen: () => void;
  onRemove?: () => void;
}): React.ReactElement {
  const toneClass = tone === 'danger' ? 'text-aico-danger'
    : tone === 'warning' ? 'text-aico-warning'
      : 'text-aico-secondary';

  return (
    <span
      className={[
        'inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-[1px] text-[10px]',
        active
          ? 'border-aico-accent bg-aico-accent-soft'
          : 'border-aico-border-subtle bg-aico-elevated',
      ].join(' ')}
    >
      <button
        type="button"
        title={title}
        onClick={onOpen}
        className={`flex min-w-0 items-center gap-1 ${toneClass} hover:text-aico-primary`}
      >
        <Icon name={icon} />
        <span className="truncate">{label}</span>
      </button>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${label}`}
          title="Remove from this message"
          onClick={onRemove}
          className="shrink-0 text-aico-muted hover:text-aico-primary"
        >
          ✕
        </button>
      )}
    </span>
  );
}

function Icon({ name }: { name: string }): React.ReactElement {
  const paths: Record<string, React.ReactNode> = {
    file: <path d="M4 1.75h5l3 3v9.5H4z" />,
    selection: <><path d="M2.5 4V2.5H5" /><path d="M11 2.5h2.5V4" /><path d="M13.5 12v1.5H11" /><path d="M5 13.5H2.5V12" /><path d="M5.5 6.5h5M5.5 9.5h3" /></>,
    symbol: <><circle cx="8" cy="8" r="2" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" /></>,
    problem: <><circle cx="8" cy="8" r="6" /><path d="M8 5v3.5M8 11h.01" /></>,
  };
  return (
    <svg
      viewBox="0 0 16 16" className="size-3 shrink-0" fill="none" stroke="currentColor"
      strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}

function base(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
