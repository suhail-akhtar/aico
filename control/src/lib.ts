/**
 * The control server as a library: what tests, the live demo and the CLI import.
 * Nothing here starts a listener by itself.
 *
 * @module lib
 */

export { ControlApp, type ControlOptions } from './app.js';
export { Store } from './store.js';
export { openDb, schemaVersion } from './db.js';
export { PERMISSIONS, ROLES, ROLE_DEFS, can, canAssign, permissionsOf, hasPortalAccess, isTeamScoped } from './rbac.js';
export { validateDoc, layersFor, leaseFor } from './policy.js';
export { chainHash, GENESIS } from './store.js';
export { resetOidcCaches, verifyIdToken, OidcError } from './oidc.js';
