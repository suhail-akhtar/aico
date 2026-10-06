export const ARTIFACT_DIRS: readonly string[];
export const DEPENDENCY_DIRS: readonly string[];
export const ARTIFACT_FILES: readonly string[];
export const LEGACY_NODE_EXTRA: readonly string[];
export const ARTIFACT_PATHS: readonly string[];
export interface ArtifactOptions { keep?: readonly string[]; extra?: readonly string[] }
export function isArtifactName(name: string, opts?: ArtifactOptions): boolean;
export function hasArtifactSegment(rel: string, opts?: ArtifactOptions): boolean;
export function templatePackageFilter(templatesRoot: string): (src: string) => boolean;
