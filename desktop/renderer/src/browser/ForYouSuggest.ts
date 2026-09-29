/**
 * Learned predictions in the address bar, blended with history and
 * bookmarks. Pure, so it is unit-tested without a DOM.
 *
 * With nothing typed, the bar offers the sites you are likely to open next
 * (a routine due now, where you usually go from here). While typing, a
 * predicted site that matches is lifted to just below what Enter would do and
 * labelled with why — never above it, so Enter still does what the text says.
 *
 * @module desktop/renderer/browser/ForYouSuggest
 */

import type { LearnPrediction } from '@desk/browser-learn-types';
import type { Suggestion } from './urls';

export type RankedSuggestion = Suggestion & { why?: string; predicted?: boolean };

const hostOf = (url: string): string => { try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };

/** Nothing typed: the predictions themselves. */
export function predictionRows(preds: LearnPrediction[], limit = 5): RankedSuggestion[] {
  return preds.slice(0, limit).map(p => ({ kind: 'history', url: p.url, title: p.site, why: p.why, predicted: true }));
}

/** While typing: at most `max` predictions (already matched to the text by main) lifted under the first row. */
export function blendPredictions(rows: Suggestion[], preds: LearnPrediction[], limit = 8, max = 2): RankedSuggestion[] {
  const out: RankedSuggestion[] = rows.map(r => ({ ...r }));
  const lead = out.length && (out[0]!.kind === 'go' || out[0]!.kind === 'search') ? 1 : 0;
  let placed = 0;
  for (const p of preds) {
    if (placed >= max) break;
    const i = out.findIndex(r => (r.kind === 'history' || r.kind === 'bookmark') && hostOf(r.url) === p.site);
    const row: RankedSuggestion = i >= 0 ? { ...out.splice(i, 1)[0]!, why: p.why, predicted: true } : { kind: 'history', url: p.url, title: p.site, why: p.why, predicted: true };
    // A history row of the same site further down would repeat it.
    if (i < 0 && out.some(r => r.url === row.url)) continue;
    out.splice(lead + placed, 0, row);
    placed++;
  }
  return out.slice(0, limit);
}
