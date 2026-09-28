/**
 * The props every kit widget receives.
 *
 * Inlined from the ops console's plugin SDK, which the widgets were written
 * against. In AICO a widget is drawn from what the model wrote in a chat reply,
 * so `options` is the whole of it: there is no live binding here, and every
 * value is shown as authored (`provenance: 'free_text'`) — except what a
 * widget computes itself (a forecast line, a fit), which the widget labels.
 *
 * @module shared/kit/types
 */

export type ProvenanceClass = 'platform' | 'structured_validated' | 'structured_derived' | 'direct_probe' | 'free_text';

export interface Threshold {
  level: 'info' | 'warn' | 'crit';
  gt?: number;
  lt?: number;
}

export interface WidgetBinding {
  source: string;
  query: string;
  [key: string]: unknown;
}

export interface WidgetProps<TOptions = Record<string, unknown>> {
  options: TOptions;
  data?: unknown;
  binding?: WidgetBinding;
  provenance: ProvenanceClass;
  thresholds?: Threshold[];
  error?: string;
  ageMs?: number;
}
