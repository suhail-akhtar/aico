import path from 'node:path';

// Reference fix (grader self-test only).
export function resolveUserFile(root, name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) return null;
  if (name.includes('\0')) return null;
  const base = path.resolve(root);
  const full = path.resolve(base, name);
  const rel = path.relative(base, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return full;
}
