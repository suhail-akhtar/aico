/**
 * Automated accessibility checks for rendered components, using axe-core.
 *
 * jsdom has no layout, so the colour-contrast rule cannot run here; the
 * Playwright suite runs axe in a real browser (contrast included) at both
 * viewport sizes. What this catches early: missing names and labels, bad ARIA,
 * duplicate ids, heading order, list and landmark structure.
 */

import axe, { type AxeResults } from 'axe-core';
import { expect } from 'vitest';

export async function runAxe(container: Element): Promise<AxeResults> {
  return axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
}

export async function expectAccessible(container: Element): Promise<void> {
  const { violations } = await runAxe(container);
  const summary = violations.map((v) => ({
    rule: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => n.target.join(' ')),
  }));
  expect(summary).toEqual([]);
}
