// Reference fix (grader self-test only).
export function isSafeRedirect(target) {
  if (typeof target !== 'string' || target.length === 0 || target.length > 2048) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(target)) return false;
  return target.startsWith('/') && !target.startsWith('//');
}
