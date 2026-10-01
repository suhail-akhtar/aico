/**
 * Whether `target` (from the ?next= parameter after login) is safe to
 * redirect to: a path on this site only.
 */
export function isSafeRedirect(target) {
  if (typeof target !== 'string' || target.length === 0 || target.length > 2048) return false;
  return target.startsWith('/');
}
