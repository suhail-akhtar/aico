import { ApiError } from '../api';

/** A sentence for a person: the API's own explanation when it gave one, a plain fallback if not. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const fields = error.errors.map((e) => `${e.field}: ${e.message}`).join('; ');
    return fields ? `${error.message} (${fields})` : error.message;
  }
  return 'Something went wrong. Check your connection and try again.';
}
