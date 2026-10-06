import { describe, expect, it } from 'vitest';
import { emptyValues, parseForm } from './form-schema';

const values = (over: Partial<ReturnType<typeof emptyValues>>) => ({ ...emptyValues(), ...over });

describe('parseForm', () => {
  it('trims text, turns an empty description into null and the quantity into a number', () => {
    expect(parseForm(values({ name: '  Pen ', description: '   ', quantity: ' 7 ' }))).toEqual({
      ok: true,
      body: { name: 'Pen', description: null, quantity: 7 },
    });
    expect(parseForm(values({ name: 'Pen', description: ' blue ' }))).toMatchObject({
      ok: true,
      body: { description: 'blue', quantity: 0 },
    });
  });

  it('accepts the limits of the contract exactly', () => {
    expect(
      parseForm(
        values({ name: 'n'.repeat(120), description: 'd'.repeat(1000), quantity: '1000000' }),
      ).ok,
    ).toBe(true);
    expect(parseForm(values({ name: 'n', quantity: '0' })).ok).toBe(true);
  });

  it('names each failing field with a catalogue message', () => {
    const result = parseForm({ name: ' ', description: 'd'.repeat(1001), quantity: '' });
    expect(result).toEqual({
      ok: false,
      errors: {
        name: 'Enter a name.',
        description: 'The description can be at most 1000 characters.',
        quantity: 'Enter a whole number from 0 to 1,000,000.',
      },
    });
    expect(parseForm(values({ name: 'n'.repeat(121) }))).toMatchObject({
      errors: { name: 'The name can be at most 120 characters.' },
    });
  });

  it('rejects fractions, negatives, too-large numbers and words as a quantity', () => {
    for (const quantity of ['1.5', '-1', '1000001', 'abc', '1e3x']) {
      expect(parseForm(values({ name: 'n', quantity })), quantity).toMatchObject({
        ok: false,
        errors: { quantity: 'Enter a whole number from 0 to 1,000,000.' },
      });
    }
  });
});
