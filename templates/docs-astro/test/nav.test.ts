import { describe, expect, it } from 'vitest';
import { buildNav, neighbours } from '../src/lib/nav';

const entries = [
  { id: 'reference', title: 'Reference', section: 'Reference', order: 100, draft: false },
  { id: 'getting-started', title: 'Getting started', section: 'Guide', order: 1, draft: false },
  { id: 'concepts', title: 'Concepts', section: 'Guide', order: 2, draft: false },
  { id: 'wip', title: 'Work in progress', section: 'Guide', order: 3, draft: true },
];

describe('buildNav', () => {
  it('groups by section, orders within, drops drafts', () => {
    const nav = buildNav(entries);
    expect(nav.map(s => s.section)).toEqual(['Guide', 'Reference']);
    expect(nav[0]!.pages.map(p => p.id)).toEqual(['getting-started', 'concepts']);
    expect(nav[0]!.pages[0]!.href).toBe('/docs/getting-started/');
  });
  it('keeps sections in the order their first page appears', () => {
    const nav = buildNav([...entries].reverse());
    expect(nav.map(s => s.section)).toEqual(['Guide', 'Reference']);
  });
});

describe('neighbours', () => {
  it('finds previous and next across sections', () => {
    const nav = buildNav(entries);
    expect(neighbours(nav, 'concepts')).toEqual({ prev: expect.objectContaining({ id: 'getting-started' }), next: expect.objectContaining({ id: 'reference' }) });
    expect(neighbours(nav, 'getting-started').prev).toBeUndefined();
    expect(neighbours(nav, 'nope')).toEqual({});
  });
});
