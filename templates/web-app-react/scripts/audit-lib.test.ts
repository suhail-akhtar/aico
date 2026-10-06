import { describe, expect, it } from 'vitest';
import { advisoriesOf, evaluate, parseAllowList } from './audit-lib.ts';

const report = {
  vulnerabilities: {
    left: {
      name: 'left',
      via: [
        {
          source: 1,
          name: 'left',
          title: 'Prototype pollution',
          severity: 'high',
          url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
        },
        'right',
      ],
    },
    right: {
      name: 'right',
      via: [
        {
          source: 1,
          name: 'left',
          title: 'Prototype pollution',
          severity: 'high',
          url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
        },
        {
          source: 2,
          name: 'right',
          title: 'Slow regex',
          severity: 'moderate',
          url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff',
        },
        {
          source: 3,
          name: 'right',
          title: 'RCE',
          severity: 'critical',
          url: 'https://github.com/advisories/GHSA-gggg-hhhh-iiii',
        },
      ],
    },
  },
};

describe('advisoriesOf', () => {
  it('lists each advisory once, ignoring the "via: package" back-references', () => {
    expect(advisoriesOf(report).map((a) => a.id)).toEqual([
      'GHSA-aaaa-bbbb-cccc',
      'GHSA-dddd-eeee-ffff',
      'GHSA-gggg-hhhh-iiii',
    ]);
  });

  it('copes with an empty or malformed report', () => {
    expect(advisoriesOf({})).toEqual([]);
    expect(advisoriesOf(null)).toEqual([]);
    expect(advisoriesOf({ vulnerabilities: { x: { via: [null, 3] } } })).toEqual([]);
  });

  it('falls back to the numeric source when there is no URL', () => {
    expect(
      advisoriesOf({ vulnerabilities: { x: { via: [{ source: 42, severity: 'high' }] } } })[0]?.id,
    ).toBe('42');
  });
});

describe('evaluate', () => {
  const advisories = advisoriesOf(report);

  it('fails on high and critical, ignores the rest', () => {
    const verdict = evaluate(advisories, [], '2026-10-06');
    expect(verdict.failing.map((a) => a.id)).toEqual([
      'GHSA-aaaa-bbbb-cccc',
      'GHSA-gggg-hhhh-iiii',
    ]);
  });

  it('lets a live allow-list entry through, and stops honouring it on the day after it expires', () => {
    const allow = [
      {
        id: 'GHSA-aaaa-bbbb-cccc',
        reason: 'not reachable: dev-only parser',
        expires: '2026-10-06',
      },
    ];
    const today = evaluate(advisories, allow, '2026-10-06');
    expect(today.allowed.map((a) => a.id)).toEqual(['GHSA-aaaa-bbbb-cccc']);
    expect(today.failing.map((a) => a.id)).toEqual(['GHSA-gggg-hhhh-iiii']);
    const later = evaluate(advisories, allow, '2026-10-07');
    expect(later.failing.map((a) => a.id)).toContain('GHSA-aaaa-bbbb-cccc');
    expect(later.expired).toHaveLength(1);
  });
});

describe('parseAllowList', () => {
  it('accepts a complete entry', () => {
    const { entries, invalid } = parseAllowList([
      { id: 'GHSA-x', reason: 'a proper reason', expires: '2027-01-01' },
    ]);
    expect(entries).toHaveLength(1);
    expect(invalid).toEqual([]);
  });

  it('rejects entries with no reason, a thin reason, or a bad date, and a non-array file', () => {
    const { entries, invalid } = parseAllowList([
      { id: 'a', reason: '', expires: '2027-01-01' },
      { id: 'b', reason: 'short', expires: '2027-01-01' },
      { id: 'c', reason: 'long enough reason', expires: 'someday' },
      null,
    ]);
    expect(entries).toEqual([]);
    expect(invalid).toHaveLength(4);
    expect(parseAllowList({}).invalid).toHaveLength(1);
  });
});
