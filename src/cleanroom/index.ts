/**
 * Clean-room reconstruction: the public surface (ADR 0041).
 *
 * @module cleanroom
 */

export * from './types.js';
export { renderScreen, screenText, stripAnsi, sgrRuns } from './ansi.js';
export { CliSandbox } from './sandbox-cli.js';
export { WebSandbox, normaliseTree } from './sandbox-web.js';
export { ApiSandbox, createSandbox } from './sandbox-api.js';
export { Recorder, readJourney, corpusDir, frameFile } from './recorder.js';
export { explore, parseHelp, pathsIn } from './explorer.js';
export { synthesize, writeSpec, renderMarkdown, inferSchema, mergeSchema, templatePath } from './spec.js';
export { prepareWorkspace, assertSpecOnly, forImplementer, implementerBrief, implementClone } from './implementer.js';
export { twinTest, scrub, prefixFor, renderTwinReport } from './twin.js';
export { decodePng, comparePng } from './pixel.js';
