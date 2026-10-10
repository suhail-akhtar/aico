/**
 * AICO Control, the engine side (ADR 0040). One import point for the CLI,
 * the server routes and the tests; the pieces are documented in their own files.
 *
 * @module control
 */

export { controlSnapshot, controlStamp, readControlState, clearControlState, graceExpired, controlStatePath, resetControlStateCache, type ControlState, type ControlSnapshot } from './state.js';
export { startLogin, completeLogin, logout, authedCall, normaliseControlUrl, ControlError, CONTROL_TOOL } from './client.js';
export { syncOnce, pullPolicy, pushNew, startControlSync } from './sync.js';
export { registerControlCommands, statusLines } from './cli.js';
export { handleControlRoute, controlView } from './routes.js';
