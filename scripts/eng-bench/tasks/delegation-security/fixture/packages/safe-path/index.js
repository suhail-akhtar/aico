import path from 'node:path';

/**
 * The absolute path of a user's stored file, given the storage root and the
 * file name from the request. Returns null when the name is not acceptable.
 */
export function resolveUserFile(root, name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) return null;
  if (name.includes('\0')) return null;
  return path.join(root, name);
}
