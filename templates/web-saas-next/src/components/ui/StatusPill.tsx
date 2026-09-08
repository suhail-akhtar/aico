export type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';

const TONES: Record<Tone, string> = {
  neutral: 'bg-surface-alt text-ink-muted',
  brand: 'bg-brand/10 text-brand',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-danger/10 text-danger',
};

/**
 * A status is a word in a coloured pill — the word carries the meaning, the
 * colour only speeds it up. Map each status of a feature to a tone once, in
 * that feature's lib file, and render it through this.
 */
export function StatusPill({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}>{children}</span>
  );
}
