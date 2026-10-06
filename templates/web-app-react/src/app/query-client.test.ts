import { describe, expect, it } from 'vitest';
import { ApiError } from '../shared/problem';
import { createQueryClient, shouldRetry } from './query-client';

const error = (status: number) => new ApiError({ status, title: String(status) });

describe('retry policy', () => {
  it('never retries an answer from the server that says "no" (4xx)', () => {
    for (const status of [400, 401, 403, 404, 422, 429])
      expect(shouldRetry(0, error(status))).toBe(false);
  });

  it('retries a blip (network, 5xx, unknown) twice, then gives up', () => {
    for (const e of [error(0), error(503), new Error('x')]) {
      expect(shouldRetry(0, e)).toBe(true);
      expect(shouldRetry(1, e)).toBe(true);
      expect(shouldRetry(2, e)).toBe(false);
    }
  });

  it('builds a client that applies it and never retries mutations', () => {
    const defaults = createQueryClient().getDefaultOptions();
    expect(defaults.queries?.retry).toBe(shouldRetry);
    expect(defaults.mutations?.retry).toBe(false);
  });
});
