import { describe, expect, it } from 'vitest';
import { ApiError, normalizeFieldErrors, parseProblem } from './problem';

describe('normalizeFieldErrors', () => {
  it('reads the {field, message} array shape', () => {
    expect(normalizeFieldErrors([{ field: 'name', message: 'Name is required.' }])).toEqual({
      name: 'Name is required.',
    });
  });

  it('reads the {loc, message} array shape and drops the location prefix', () => {
    expect(
      normalizeFieldErrors([
        { loc: ['body', 'quantity'], message: 'Too big', type: 'less_than_equal' },
        { loc: ['query', 'limit'], message: 'Bad limit' },
      ]),
    ).toEqual({ quantity: 'Too big', limit: 'Bad limit' });
  });

  it('reads the {field: [messages]} map shape (ASP.NET) and lower-cases names', () => {
    expect(
      normalizeFieldErrors({ Name: ['Required', 'Too short'], 'item.Quantity': ['Negative'] }),
    ).toEqual({
      name: 'Required',
      quantity: 'Negative',
    });
  });

  it('keeps the first message per field and ignores junk', () => {
    expect(
      normalizeFieldErrors([
        { field: 'name', message: 'first' },
        { field: 'name', message: 'second' },
        { message: 'no field' },
        null,
        'text',
        { field: 'x', message: 5 },
      ]),
    ).toEqual({ name: 'first' });
    expect(normalizeFieldErrors(undefined)).toEqual({});
    expect(normalizeFieldErrors('boom')).toEqual({});
    expect(normalizeFieldErrors({ a: 3 })).toEqual({});
  });
});

describe('parseProblem', () => {
  it('builds an ApiError from RFC 9457 details', () => {
    const error = parseProblem(
      422,
      {
        title: 'Unprocessable Content',
        detail: 'Bad item.',
        request_id: 'r-1',
        errors: [{ field: 'name', message: 'x' }],
      },
      'header-id',
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 422,
      title: 'Unprocessable Content',
      detail: 'Bad item.',
      requestId: 'r-1',
      fieldErrors: { name: 'x' },
      message: 'Bad item.',
    });
    expect(error.isUnauthorized).toBe(false);
    expect(error.isNetwork).toBe(false);
  });

  it('falls back to the request-id header and to a status title', () => {
    expect(parseProblem(500, {}, 'abc')).toMatchObject({ title: 'HTTP 500', requestId: 'abc' });
  });

  it('keeps a short plain-text body (a proxy answer) but never markup', () => {
    expect(parseProblem(401, 'Unauthorized').detail).toBe('Unauthorized');
    expect(parseProblem(401, 'Unauthorized').isUnauthorized).toBe(true);
    expect(parseProblem(502, '<html>bad gateway</html>').detail).toBeUndefined();
  });

  it('marks a missing response as a network error', () => {
    const error = parseProblem(0, undefined);
    expect(error.isNetwork).toBe(true);
    expect(error.title).toBe('Network error');
  });
});
