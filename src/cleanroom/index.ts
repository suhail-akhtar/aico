/**
 * Clean-room reconstruction: the public surface (ADR 0041).
 *
 * @module cleanroom
 */

export * from './types.js';
export { renderScreen, screenText, stripAnsi, sgrRuns } from './ansi.js';
export { CliSandbox, ptyAvailable, keyToSequence } from './sandbox-cli.js';
export { WebSandbox, normaliseTree } from './sandbox-web.js';
export { ApiSandbox, createSandbox } from './sandbox-api.js';
export { LibrarySandbox, detectLanguage } from './sandbox-library.js';
export { DaemonSandbox } from './sandbox-daemon.js';
export { DesktopSandbox } from './sandbox-desktop.js';
export { MobileSandbox, parseUiXml } from './sandbox-mobile.js';
export { daemonSpec } from './daemonspec.js';
export { librarySpec, renderDts, renderPyi, argKind } from './libspec.js';
export { Recorder, readJourney, corpusDir, frameFile } from './recorder.js';
export { explore, parseHelp, pathsIn, coverageLine, readExplorerState, argVectors, DAEMON_PROBES } from './explorer.js';
export type { ExplorerState, Guide, GuideView } from './explorer.js';
export { createGuide, createModelCompleter, parsePicks } from './guide.js';
export { diffSpecs, renderSpecDiff } from './specdiff.js';
export { synthesize, writeSpec, renderMarkdown, inferSchema, mergeSchema, templatePath } from './spec.js';
export { prepareWorkspace, assertSpecOnly, forImplementer, implementerBrief, implementClone } from './implementer.js';
export { twinTest, scrub, prefixFor, renderTwinReport } from './twin.js';
export { decodePng, comparePng } from './pixel.js';
export { WORKSPACE_MARKER, WALL_TOOLS, isWorkspace, wallRefusal, installCleanroomWall, permissionFlags, realish } from './wall.js';
