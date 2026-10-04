export { classifyBashCommand, isBashReadOnly } from './safety.js';
export { executeTool, truncateResult } from './tools/index.js';
export { resolveFileAttachment, parseAttachTokens } from './attachments.js';
export { buildSystemPrompt } from './prompts.js';
export {
  saveSession,
  loadSession,
  generateSessionId,
  appendMessage,
  listSessions,
  getSessionDir,
} from './history.js';
export { handleSlashCommand } from './commands.js';
export { createTokenTracker, estimateTokens } from './tokens.js';
export { readMemory, loadMemory } from './memory/index.js';
export { runHooks, freezeHooks, resetHooks } from './hooks.js';
// Exports for the new-logic test suites
export { getOpenTodoCount, todoWrite, todoRead, retireTodos } from './tools/todo.js';
export {
  getModelCapabilities, modelAccepts, modelProduces, modelCanChat, explainRefusal,
  resetCapabilityCache, MODALITIES,
  recordModelCapabilities, recordCatalogueModalities, learnedCapabilities, flushCapabilityCache,
  capabilityCachePath,
} from './model-capabilities.js';
export {
  offerToolImage, sniffImageType, drainToolImages, toolImagesMessage, createToolImageSink,
  MAX_TOOL_IMAGE_BYTES,
} from './tools/tool-images.js';
export {
  classifyImageProbe, runImageProbe, probeModelImageInput, solidPng, probeImage,
} from './providers/capability-probe.js';
export { readInputModalities } from './providers/connection-test.js';
export { McpBaseClient, mcpImages } from './mcp/base.js';
export { webFetch } from './tools/webfetch.js';
export { maybeAutoCompactConversation, getCompactionThreshold } from './compact.js';
export {
  getContextWindow, getEffectiveContextBudget, resetContextWindowCache,
  detectContextWindow, ensureContextWindow,
  resolveWindow, isStale, learnWindowFromError, setContextWindow,
} from './context-window.js';
export { AGENT_PROMPTS } from './agents/prompts-registry.js';
// ── Session event log ─────────────────────────────────────────────────
export {
  Session,
  canonicalHeader,
  headerEquals,
  deriveMessages,
  deriveMessagesDetailed,
  computeShadowedSeqs,
  isSurfaceEvent,
  formatTurnEndReason,
  MISSING_RESULT_TEXT,
  SURFACE_EVENT_TYPES,
  checkSessionInvariants,
  assertSessionInvariants,
  initEventLog,
  loadEventLog,
  persistSession,
  eventLogPath,
  listEventLogs,
  openSession,
} from './session/index.js';
export { SessionTranscript, LegacyTranscript } from './session/transcript.js';
export { Inbox, inboxView, deliveryStep } from './session/inbox.js';
export {
  maybeCompactSession,
  formatCompactionResult,
  serializeSessionTranscript,
  describeSessionContext,
} from './session/compact.js';
export { buildConversationSummary } from './compact.js';
// ── Capability registry ───────────────────────────────────────────────
export {
  Context,
  createContext,
  createRootContext,
  createLlmCapability,
  createSessionsCapability,
  createToolPolicyCapability,
  DefaultToolRegistry,
} from './registry/index.js';
// ── Sandbox ───────────────────────────────────────────────────────────
export {
  LocalSandbox,
  canonicalize,
  installSandboxGuard,
  isWithin,
  resolveSandboxPolicy,
  temporaryRoot,
  SUBPROCESS_PARTIAL_REASON,
} from './sandbox/index.js';
export {
  selectProvider,
  detectProviderType,
  requiresResponsesApi,
  isDeepSeekPlatformModel,
} from './providers/index.js';
export {
  DeepSeekProvider,
  toDeepSeekMessages,
  toDeepSeekTools,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_OUTPUT_TOKENS,
} from './providers/deepseek.js';
export { chainAbort, withIdleTimeout, STREAM_IDLE_TIMEOUT_MS } from './providers/idle-timeout.js';
// ── Provider usage normalization + Anthropic prompt caching ───────────
export {
  normalizeUsage,
  CACHE_READ_RATE_MULTIPLIER,
  CACHE_WRITE_RATE_MULTIPLIER,
} from './providers/usage.js';
export {
  toAnthropicMessages,
  applyMessageCacheBreakpoints,
  appendVolatileContext,
  supportsAdaptiveThinking,
  serializeThinkingBlocks,
  parseThinkingBlocks,
  MESSAGE_CACHE_BREAKPOINTS,
  ANTHROPIC_DEFAULT_MAX_TOKENS,
} from './providers/anthropic.js';
export { buildVolatileContext } from './prompts.js';
// ── Provider-adaptive prompt layer ────────────────────────────────────
export {
  PromptDocument,
  renderPrompt,
  renderTail,
  renderSection,
  titleFromId,
  ANTHROPIC_DIALECT,
  OPENAI_DIALECT,
  DEEPSEEK_DIALECT,
  GEMINI_DIALECT,
  DEFAULT_DIALECT,
} from './prompt/index.js';
export { dialectForRoutedModel } from './providers/index.js';
export { usesMaxCompletionTokens, supportsReasoningEffort } from './providers/openai.js';
export { toResponsesInput, toResponsesTools } from './providers/openai-responses.js';
// ── Tool pipeline + guards ────────────────────────────────────────────
export { ToolPipeline, addContext } from './tools/pipeline.js';
export {
  scheduleToolCalls,
  resolveMaxParallel,
  DEFAULT_MAX_PARALLEL_TOOL_CALLS,
} from './tools/scheduler.js';
export {
  RepeatToolGuard,
  canonicalizeArguments,
  matchesPattern,
  resolveRepeatGuardConfig,
} from './tools/repeat-guard.js';
// -- Web server (aico serve) --
export { serve } from './server/index.js';
export { EventHub } from './server/events.js';
export { RunManager } from './server/runs.js';
// -- Provider instances (the settings configuration model) --
export {
  PROVIDER_TYPES,
  PROVIDER_TYPE_IDS,
  listInstances,
  findInstance,
  resolveInstance,
  resolveApiKey,
  resolveBaseUrl,
  keySourceOf,
  isUsable,
  normalize as normalizeInstance,
  redactInstance,
  validateInstance,
} from './providers/instances.js';
export { providerFromInstance } from './providers/index.js';
export { testProvider } from './providers/connection-test.js';
// -- Work ledger, supervisor and watchers --
export { ledger } from './work/ledger.js';
export { setWorkStorePath, readWorkLog, compactWorkLog, pidAlive } from './work/store.js';
export { evaluate as evaluateBreach, sweepOnce, supervisor } from './work/supervisor.js';
export {
  registerStopHandle, clearStopHandle, invokeStop, resetStopHandlesForTest,
} from './work/handles.js';
export {
  watch, unwatch, setWakeDelivery, activeWatcherCount, resetWatchersForTest,
} from './work/watchers.js';
export { registerBackgroundProcess, closeBackgroundProcess, openCronRun, closeCronRun } from './work/register.js';
export { isTerminal as isTerminalWorkState, reportsProgress } from './work/types.js';
export { renderRunningWork } from './work/projection.js';
export { stopWork } from './work/handles.js';
export { buildMcpTools } from './mcp-server/tools.js';
export { attachMcpHandlers } from './mcp-server/index.js';
export { Rpc as McpRpc, textResult as mcpTextResult } from './mcp-server/protocol.js';
export { McpStdioClient } from './mcp/stdio.js';
export { McpHttpClient } from './mcp/http.js';
export { hostCallMeta } from './mcp/registry.js';
export { costFor } from './tokens.js';
export { decideHeadlessPermission } from './background/index.js';
export { cronScheduler } from './cron/scheduler.js';
export { canAskUser, NO_ONE_TO_ASK } from './tools/askuser.js';
export { startLedgerMirroring, stopLedgerMirroring, setAdapterSettings } from './work/adapters.js';
export { executeCronCreate, executeCronList } from './cron/tools.js';
export {
  openCronFiring, followCronFiring, cronFiringSummary, cronFiringInFlight, liveCronFirings,
} from './work/cron-run.js';
export { setMcpPermissions, mcpPermissions } from './mcp-server/tools.js';
// -- Session titles --
export {
  normalizeSessionTitle, fallbackSessionTitle, parseModelTitle, truncateTitleUtf8,
  currentTitle, acceptsAutomaticTitle, buildTitleRequest,
  TITLE_MAX_BYTES, FALLBACK_MAX_WORDS,
} from './session/title.js';
export { writeFallbackTitle, writeUserTitle, pickNamingModel } from './session/title-service.js';
export { listSessionSummaries, isUsedSession } from './session/persistence.js';
// -- Session projections (goal, feedback, deliverables, timing) --
export {
  currentGoal,
  feedbackBySeq,
  deliverables,
  stepTimings,
  trajectory,
} from './session/projections.js';
// -- Transcript export + workspace write roots --
export { toMarkdown, toPlainText, exportFilename } from './session/export.js';
export { resolveInsideWorkspace, writableRoots, resolveForReading, readableRoots } from './tools/path.js';
export { resolveWorkspaceRoot, setWorkspaceRuntime, getWorkspaceInfo } from './workspace.js';
// -- Streamed command output --
export { bash, setBashProgressSink } from './tools/bash.js';
// -- Turn summary --
export { summarizeLastTurn } from './session/summary.js';
export { vendorForModel, isDirectVendor } from './providers/model-vendor.js';
export { runInContext, currentCwd, currentRunContext } from './run-context.js';
export { forkSession } from './session/persistence.js';
export { spillResult, saveSpill, excerpt, setSpillDir, spillDir } from './tools/spill.js';

export { verifyApp, formatVerdict, findBrowser, verifyAppDefinition } from './tools/verify-app.js';
export { checkVerificationGate, resetVerification, recordVerification, noteFileWritten, webArtifacts, verifications } from './verification.js';
export { findPlaceholders, describePlaceholders } from './substance.js';
export { getToolsForAgent, toolDefinitions } from './tools/index.js';
export { looksLikeServer, resolveTimeout, backgroundProcesses, stopBackgroundProcesses } from './tools/bash.js';
export { extractRequirements, coverageOf, setBrief, currentRequirements, MIN_INTERACTIONS_FOR_COVERAGE } from './requirements.js';
export { withTimeout, timeoutFor, timeoutMessage, ToolTimeoutError } from './tools/timeout-policy.js';
export { terminal, closeAllTerminals, terminalDefinition } from './tools/terminal.js';
export { detectShell, resetShellChoiceForTest } from './tools/shell-choice.js';
export {
  LADDER, reasoningFor, supportsReasoning, effortToSend,
  learnFromError, resetReasoningForTest,
} from '../shared/reasoning.js';
export { resolvedEffort } from './run-context.js';
export { resolveToolSet, isRetryableError, buildToolDefs } from './agent.js';
export {
  TOOL_GROUPS, LOAD_TOOLS, groupOf, groupsForRequest, groupsLoadedBy, loadedGroupsFromLog, isDeferred, loadToolsDefinition, executeLoadTools,
} from './tools/deferred.js';
export { HOST_TOOLS, hostToolsFrom, isHostTool } from '../shared/host-tools.js';
export {
  vsCodeDiagnostics, vsCodeTasks, vsCodeWorkspace,
} from './tools/vscode.js';
export { cacheKey } from './skills/eval/run.js';
export {
  describeCorpus, startEval, startOptimize, getJob, cancelJob, adoptCandidate,
} from './skills/eval/jobs.js';
export { observe, blockedReason, resetObservations, isObserved } from './tools/observation.js';
export { runScoped } from './run-scoped.js';
export { detectChecks, isSourceFile, resetChecks, noteSourceChanged, recordCheck, checkProjectGate, checkResults, newestSourceChange, touchedFiles } from './checks.js';
export { runChecks } from './tools/run-checks.js';
export { parseTestOutput, parseJUnitXml, formatTestSummary } from './test-results.js';
export { detectStyleTools, styleChecks } from './style-tools.js';
export {
  dependencyAudit, parseNpmAudit, parsePipAudit, parseCargoAudit, parseDotnetVulnerable, parseGovulncheck,
  classifyLicense, scanNodeLicenses, scanPythonLicenses, findSitePackages, detectEcosystems, formatAudit,
  DEFAULT_ALLOWED_LICENSES,
} from './tools/dependency-audit.js';
export { listChanges, diffOf, revertFile, isGitRepo, gitLog } from './server/changes.js';
export { projectStats } from './project/stats.js';
export {
  listProjects, addProject, updateProject, removeProject, normalizeProjectPath,
  isKnownProject, instructionsFor,
} from './server/projects.js';
export { handleSystemRoute, safetyWeakening } from './server/api-system.js';
export { useSkill, skillCatalogue, skillDefinition, describeSize } from './tools/skill.js';
export { skillRegistry } from './skills/registry.js';
export { executeSkillCreate } from './skills/create.js';
export { executeSkillManage, verifySkillDir, draftsDir } from './skills/manage.js';
export { setEnabled, isDisabled, disabledIn, registryStatePath } from './registry-state.js';
export { matchingSkills, skillsToSuggest } from './tools/skill.js';
export { executeAgentManage } from './tools/manage-agents.js';
export { resolveAgent, inlineSkills, personaFor } from './agents/resolve.js';
export { currentAgent, currentModel } from './session/projections.js';
export { executeMemoryManage } from './tools/manage-memory.js';
export { executeMcpManage, splitCommandLine, parseMcpConfig } from './mcp/manage-tool.js';
export { remember, listScope, applicable, activeMemories, memoryRoot, scopeDir, searchMemories, setMemoryEnabled, memoryKey } from './memory/store.js';
// Recall (ADR 0018): index, search, episodes, injection split, upkeep, tool.
export { setMemoryPinned, findNearDuplicate } from './memory/store.js';
export {
  recallDb, recallDbPath, closeRecall, syncAll, syncMemories, syncEpisodes, rebuildRecall, listItems, getItem, countItems,
  upsertProfileItems, removeProfileItem, registerProfileSource, setEmbedding, recordUse,
} from './recall/store.js';
export { searchRecall, recencyWeight, visibleTo } from './recall/search.js';
export { episodeFromLog } from './recall/episodes.js';
export { embedPending, embedRole, embedderFromSettings, cosine } from './recall/embed.js';
export { splitMemories, recalledMemoryBlock } from './recall/inject.js';
export { runRecallUpkeep, upkeepDue } from './recall/upkeep.js';
export { ftsQuery, subjectOf, jaccard as recallJaccard } from './recall/text.js';
export { recallTool } from './tools/recall.js';
export { handleRecallRoute } from './recall/index.js';
export { updateMcpServer } from './mcp/manage.js';
export { buildRuntimeAwareness, buildRuntimeBlocks } from './capabilities.js';
export { capGitStatus, GIT_STATUS_MAX_LINES, GIT_STATUS_MAX_CHARS, MEMORY_REPRISE_MAX_CHARS } from './prompts.js';
export { sectionHashes } from './prompt/render.js';
export { cacheResets, cacheShare, describeReset } from './session/cache.js';
export {
  loadProfile, mergeProfile, saveProfile, updateProfile, checksFor, renderProfile, profileFromTemplate,
  detectStack, forgetCommand, emptyProfile, profilePath, COMMAND_NAMES, PROFILE_RENDER_MAX,
} from './project/profile.js';
export { observeCommand, installProfileObserver } from './project/observe.js';
export { detectChecksFor } from './checks.js';
export { projectRoot, currentApp } from './run-context.js';
export { servedArtifacts } from './verification.js';
export { gateChecks } from './tools/run-checks.js';
export { deployKey, toolAvailable, missingRequirements, deployApp, deployState } from './apps/deploy.js';
export {
  extractFromTurn, fromFeedback, fromSteering, fromChecksFix, fromVerifyFix, fromRepeatedErrors,
  dedupe as dedupeProposals, normaliseError, overlap as wordOverlap, PROPOSAL_TTL_MS, DEDUPE_OVERLAP,
} from './learning/extract.js';
export {
  listProposals, addProposals, setProposalStatus, adoptProposal, markAdoptedByContent, proposalsFile, projectKey, MAX_OPEN,
} from './learning/proposals.js';
export {
  readUserModel, writeUserModel, addUserModelLine, renderUserModel, capUserModel, fromUserSignals, userModelPath,
  USER_MODEL_MAX_LINES, USER_MODEL_MAX_CHARS,
} from './learning/user-model.js';
export { readDecisions, countDecisions, seedDecisions, appendDecision, decisionsNote, decisionsPath, DECISIONS_BULLET } from './project/decisions.js';
export { recommendedAgentModels, unsetCheapRoles, CHEAP_ROLES } from './agents/economy.js';
export { CHEAP_MODELS, familyOfModel } from '../shared/models.js';
export { suggestKnowledge } from '../shared/knowledge-suggest.js';
export {
  guardPageText, scanInstructions, scorePassage, isInstructionLike, stripHiddenHtml, stripInvisibleUnicode, inlineConcealment, guardNotice,
  FLAG_THRESHOLD, UNTRUSTED_OPEN, UNTRUSTED_CLOSE,
} from '../shared/injection-guard.js';
export { exportSkill } from './skills/import.js';
export { listDirectory } from './tools/ls.js';
export { globFiles } from './tools/glob.js';
export { grepFiles } from './tools/grep.js';
export { loadAllSkills, discoverSkillFiles, parseSkillFile, getBuiltinDir } from './skills/loader.js';
export { importSkill, removeSkill, userSkillsDir } from './skills/import.js';
export { imageDimensions, describeOversize, IMAGE_LIMITS } from './server/image-dimensions.js';
export { projectImages, budgetImages } from './agent.js';
export {
  compareVersions, highestVersion, repoSlug, updateNotice,
  refreshUpdateCache, pendingUpdate,
} from './update-check.js';
export { createChildTracker } from './tokens.js';
export {
  buildCodeMap, overview, listDirectory as codeMapListDirectory,
  findSymbol, searchPurpose, resetCodeMapCache,
} from './codemap/index.js';
export { extractSymbols, extractPurpose, languageFor } from './codemap/extract.js';
export { gitTool } from './tools/git.js';
export { matchKnowledge, renderKnowledge, meaningfulWords } from './knowledge/match.js';
export { parseEntry, loadKnowledge, saveKnowledge, deleteKnowledge } from './knowledge/store.js';
export { knowledgeTool } from './tools/knowledge.js';
export {
  beginCheckpoint, commitCheckpoint, listCheckpoints, restoreCheckpoint,
  recordBeforeWrite, recordAfterWrite, resetCheckpoints, isRecording,
  snapshotFiles, sealSnapshot,
} from './checkpoint/index.js';
export {
  applyPlan, makePlan, planKey, rememberPlan, shownPlan, plannedWriteTargets, isApplyCall, renderPlan,
  rollbackLastApply, resetRefactorPlans,
} from './refactor/plan.js';
export { findAstGrep, rewriteChanges, codeSearch, resetAstGrepCache } from './refactor/ast-grep.js';
export { ProjectService, renameChanges, findReferences as tsFindReferences, organizeImportsChanges, moveFileChanges, loadTypeScript } from './refactor/ts-service.js';
export { executeCodeSearch, executeCodeRewrite, executeRefactor } from './tools/refactor.js';
export { investigate, investigateDefinition, findDuplicateAngles } from './tools/investigate.js';
export { getWidgetSpec, widgetSpecDefinition } from './tools/widget-spec.js';
export {
  WIDGET_CATALOG, widgetForLanguage, widgetById, catalogLines,
} from '../shared/widgets/catalog.js';
export { DIAGRAM_TYPES, diagramType, diagramIndex } from '../shared/widgets/diagram-types.js';
export { selectToolProfile } from './agent.js';
export {
  owningSession, registerOwnerForTest, requestAgentStop, guideAgent, detachedRun,
  taskToolDefinition, runTask, getAgentRegistry, briefProblem, composeBrief, canWrite,
  canonicalAgentType, TASK_AGENT_TYPES,
} from './tools/task.js';
export { workOf, absorbWork } from './checks.js';
export { REPORT_CONTRACT } from './agents/prompts-registry.js';
export { executeSupervise, superviseToolDefinition } from './tools/supervise.js';
export { loadSettings } from './settings.js';
export {
  createMiniApp, miniAppDir, getMiniApp, listMiniApps, effectiveKind, hasProcess, runProfileFor, backlogProgress,
} from './miniapps/store.js';
export { miniAppContext, fileList, appStateLine } from './miniapps/context.js';
export {
  listTemplates, getTemplate, validateManifest, suggestTemplates, matchScore, stem, renderCatalogue, substituteTokens,
  matchesSubstitute, instantiateTemplate, nodeSatisfies, bundledTemplatesDir, REQUIRED_TEMPLATE_FILES,
  initAppGit, createCustomApp,
} from './apps/templates.js';
export { executeAppManage, appManageToolDefinition } from './tools/manage-miniapps.js';
export { runAgent } from './agent.js';
export {
  scrubbedEnv, startApp, stopApp, appState, runningApps, subscribeToApps,
} from './miniapps/process.js';
export { nextAuthoringContract } from './miniapps/contract-nextjs.js';
export { splitStatements, closeAll as closeAllAppDatabases, closeDatabase as closeAppDatabase } from './miniapps/data.js';
export { executeMiniAppManage } from './tools/manage-miniapps.js';
export { authoringContract } from './miniapps/contract.js';
export {
  grade, runCheck, hashFiles, corpusFor, BUILTIN_CORPUS, splitOf, assignSplits,
  evalSkill, runTask as runEvalTask, materialise, renderTask,
  applyEdits, buildProposalPrompt, defaultBudget, optimizeSkill, parseProposal,
} from './skills/eval/index.js';
export { windowFromCatalogue, clearContextWindow, noteWindowFromUsage, standardWindowAtLeast } from './context-window.js';
export { aicoHome } from './home.js';
export { executeContextWindow, contextWindowToolDefinition } from './tools/context-window.js';
export {
  KimiProvider, toKimiMessages, toKimiTools, reasoningFieldsFor, reasoningShapeFor,
  KIMI_BASE_URL, KIMI_MODELS, KIMI_DEFAULT_MAX_OUTPUT_TOKENS,
} from './providers/kimi.js';
export { isKimiModel } from './providers/model-vendor.js';
export { watchMemoryFile, stopMemoryWatcher } from './memory/watcher.js';
export { patchUserProviderTuning } from './settings.js';
export { effortDisplay, tuningPatch, tuningChoice, FAMILY_REASONING } from '../shared/reasoning.js';

export { readWorkbook, columnIndex, serialToIso } from './tools/xlsx-lite.js';
export { readAttachment } from './tools/read-attachment.js';
// -- Long-horizon context management --
export { ContextManager, ContextOverflowError, HANDOFF_INSTRUCTION } from './session/context-manager.js';
export { maskedResult, maskedCall, isMaskable, MASK_EXEMPT_TOOLS } from './session/mask.js';
export { buildHandoff, sectionOf, ASKED_HEADING, TODO_HEADING, PLAN_HEADING, CHANGED_HEADING } from './session/handoff.js';
export { planMidTurnCut, composeSummary } from './session/compact.js';
export { maskState } from './session/derive.js';
export { AnthropicProvider } from './providers/anthropic.js';
export { readTodos } from './tools/todo.js';
export { OpenAIResponsesProvider } from './providers/openai-responses.js';
export { patchUserSettingPath } from './settings.js';
export { showCommit, listBranches, switchBranch, createBranch, revertCommit, isValidBranchName, gitStatus, fileDiff, stage, unstage, discard, commit as gitCommit, push as gitPush, stashList, stashPush, stashPop, deleteBranch } from './server/git-ops.js';
export { parseHostMcp } from './bootstrap.js';
// -- Keyless data tools and image generation --
export { setNetFetch, userAgent, RequestSpacer, TtlCache } from './tools/net.js';
export { parseOpeningHours, isOpenAt, openNow } from './tools/opening-hours.js';
export { places, resetPlacesForTests, classifyQuery, overpassQuery } from './tools/places.js';
export { weather, resetWeatherForTests, describeWmo } from './tools/weather.js';
export { currencyRates, resetCurrencyForTests } from './tools/currency.js';
export { sportsScores, resetSportsForTests, resolveLeague, resolveDate, espnGame, espnStatus, espnStandings, tsdbGame } from './tools/sports.js';
export { generateImage, pickImageBackend, openAiImageRequest, estimateImageCost } from './tools/generate-image.js';
export { storeAttachment, readStoredAttachment } from './server/attachments.js';
export {
  createCanvas, getCanvas, listCanvases, writeCanvas, restoreCanvas, applyFindReplace, onCanvasChange,
  CANVAS_VERSION_CAP, CANVAS_MAX_CHARS,
  migrateCanvas, addTab, renameTab, deleteTab, addComment, replyToComment, resolveComment, listComments,
  onCanvasActivity, onCanvasComments, setDocSettings,
} from './canvas/store.js';
export {
  SECTION_ID, listSections, findSection, replaceSection, pendingBlocks, pendingLine, parsePendingLine, stripPending, sectionAt,
} from './canvas/sections.js';
export { locate as locateAnchor, reanchor, project as projectMarkdown, addressesAgent } from './canvas/comments.js';
export { exportCanvas, exportSource, toHtml, buildHtml, headingPages, pdfLayout, runningText } from './canvas/export.js';
export { cleanSettings, mergeSettings, resolveSettings, controlValues, expandRunning } from './canvas/doc-settings.js';
// -- Document design (ADR 0022) --
export { planDocument, frontModel } from './canvas/doc-plan.js';
export { toDocx, tableCapacity } from './canvas/docx.js';
export * as DocBlueprints from '../shared/ui/canvas/doc-blueprints.js';
export * as DocLayout from '../shared/ui/canvas/doc-layout.js';
export {
  DOC_TYPES, VISUAL_BLOCKS, docTypeById, pickDocType, classificationOf, writingNote, docTypeSummary, BLOCK_SYNTAX,
} from './canvas/doc-types.js';
export { parseInfographic, parseImageAttrs, normalizeAlternateSyntax } from './canvas/infographics.js';
export { collectVisuals, renderVisuals, chartSvg, launchExportBrowser, rendererRoot, clearVisualCache } from './canvas/visuals.js';
export { collectHeadings } from './canvas/doc-model.js';
export { workspaceImages, decodeDataUrl, parseMarkdown } from './canvas/markdown.js';
export { commentPrompt } from './server/canvas-routes.js';
export { canvasTool, canvasDefinition } from './tools/canvas.js';
// -- AICO Sheets --
export { renameCanvas } from './canvas/store.js';
export { bookToXlsx, xlsxToBook, csvToBook, importSheetFile, exportSheet, numFmtCode } from './canvas/sheet-xlsx.js';
export { listArtifacts, handleArtifactRoute } from './server/artifact-routes.js';
export { handleCanvasRoute } from './server/canvas-routes.js';
export * as SheetModel from '../shared/ui/canvas/sheet-model.js';
export * as SheetFormula from '../shared/ui/canvas/sheet-formula.js';
// -- Inline (scoped) AI edits, ADR 0024 --
export { editPart, editDocPart, editPrompt, docInfo, EDIT_SYSTEM, EDIT_EFFORT } from './canvas/inline-edit.js';
export * as ScopedEdit from '../shared/ui/canvas/scoped-edit.js';
export * as ScopedDiff from '../shared/ui/canvas/scoped-diff.js';
export * as DeckScopedEdit from '../shared/ui/canvas/deck-scoped-edit.js';
export { editDeckPart, deckPatchFromContent, deckTargetOf, deckEditPartTool } from './canvas/deck-inline-edit.js';
// -- Credential vault & broker --
export {
  getVault, configureVault, resolve as vaultResolve, redactor as vaultRedactor, redact as vaultRedact,
  VaultError, PolicyDeniedError, ApprovalDeniedError, GrantRequiredError, CredentialNotFoundError, VaultTamperedError,
} from './vault/index.js';
export { VaultService } from './vault/service.js';
export { VaultStore, similarNames } from './vault/store.js';
export {
  sealRecord, openRecord, deriveKeys, newMasterKey, macRecords, parseVaultFile, writeFileAtomic, withFileLock,
  wrap as vaultWrap, unwrap as vaultUnwrap,
} from './vault/crypto.js';
export { memoryKeyProvider, passphraseKeyProvider, injectMasterKey, clearInjectedKey, dpapiKeyProvider, defaultKeyProvider } from './vault/keys.js';
export { Redactor, variantsOf, MIN_SECRET_LENGTH, FULL_ENCODING_LENGTH } from './vault/redact.js';
export { setActiveRedactor, activeRedactor, sinkRedact, sinkRedactText, sinkRedactAccumulated, stashCallEnv, takeCallEnv } from './vault/sink.js';
export {
  hostMatches, originMatches, parseOrigin, isPrivateHost, evaluateUse, isLoosening, normalizePolicy, effectiveScope,
  SessionGrants, RateTracker,
} from './vault/policy.js';
export { parsePlaceholders, substitutePlaceholders, referenceFor, hasPlaceholders } from './vault/placeholders.js';
export { generatePassword, generateToken, generateSshKeyPair } from './vault/generate.js';
export { scanForSecrets, looksLikeSecret } from './vault/scan.js';
export { fileToolDenial, shellDenial } from './vault/guard.js';
export { installVaultStages, bindShellPlaceholders, envReference } from './vault/pipeline.js';
export { HumanGrants, PendingApprovals, PendingRequests, denyPrompter } from './vault/human.js';
export { AuditLog } from './vault/audit.js';
export { handleVaultRoute } from './vault/http.js';
export { attachVaultHostChannel } from './vault/host-channel.js';
export { guardAgentRun, quarantineIfEnabled } from './vault/agent-hooks.js';
export {
  credentialList, credentialRequest, credentialGenerate, VAULT_TOOL_CLASSES,
} from './tools/credentials.js';
// -- Human decisions and encrypted vault backups (credential UX) --
export { DecisionGate, decisionGate, resetDecisionGate } from './server/decision-gate.js';
export { sealExport, openExport } from './vault/backup.js';
// -- Ops tools: SSH, HTTP APIs, WinRM, SNMP with vault credentials (tools/ops) --
export { classifyRemoteCommand, isDestructiveHttpMethod } from './tools/ops/destructive.js';
export {
  parseKnownHosts, checkHostKey, hasEntryFor, formatEntry, fingerprintOf, keyTypeOf, hostToken, readKnownHosts, trustHostKey, knownHostsPath,
} from './tools/ops/known-hosts.js';
export { planRemoteCommand, MarkerWatch, shQuote, lineSafe } from './tools/ops/ssh-command.js';
export { classifyAddress, decideTarget, expandV6, resolveAll } from './tools/ops/ssrf.js';
export { parseAuth, applyAuth, originOf, redirectPlan, maskJsonSecrets, shownHeaders, jsonPath, httpRequest } from './tools/ops/http.js';
export { sshExec, sshCopy, sshTunnel, sshPurpose, probeHostKey, parseMode, localPathDenial, activeTunnelPorts } from './tools/ops/ssh.js';
export { bindPowerShellPlaceholders, buildWinRmDriver, runPowerShellDriver, psQuote, winRmExec } from './tools/ops/winrm.js';
export { snmpQuery, validOid, renderValue } from './tools/ops/snmp.js';
export { maskUnknownSecrets, checkRate, resetOpsRateForTest, useCredential, runWithOpsPrompter, MAX_APPROVAL_PURPOSE, setOpsProgressSink } from './tools/ops/common.js';
export { OPS_TOOL_NAMES, opsToolDefinitions, executeOpsTool, installOpsStages, isOpsTool } from './tools/ops/index.js';
export { callbackPrompter } from './vault/human.js';
export { toolRequiresPermission } from './permissions.js';

// -- Browser copilot hand-off to a full chat (shared/chat-handoff, server/chat-handoff, tools/handoff-to-chat) --
export { handOffToChat as serverHandOffToChat, mintSessionId } from './server/chat-handoff.js';
export { handOffToChat as handOffToChatTool, handOffToChatDefinition } from './tools/handoff-to-chat.js';
export { COPILOT_WITHHELD } from './agent.js';
export { COPILOT_BRIEF } from './prompts.js';
export * as chatHandOff from '../shared/chat-handoff.js';

// -- Phase 0 of the agents/skills/tools design (scripts/phase0-security-test.mjs) --
export { mcpRegistry } from './mcp/registry.js';
export { SkillRegistry, projectSkillDirs } from './skills/registry.js';
export { loadTrust } from './trust.js';
export {
  projectTrustStatus, ensureProjectTrust, approveProjectTrust, evaluateProjectLayers, trustPromptDetail,
  untrustedNotice, TRUST_GATED_SECTIONS,
} from './workspace-trust.js';
export {
  narrowScope, scopeAllows, scopeDenial, layerFor, mcpEntryMatches, entryMatches, OPEN_SCOPE,
} from './agents/effective.js';
export { isMcpToolName, isReadOnlyMcpTool, parseMcpToolName, HOST_READ_TOOLS } from './mcp/policy.js';
export { mcpToolAllowed } from './agent.js';
// Phase 6: MCP modernisation
export { mcpToolGroups, isDeferredMcpServer } from './agent.js';
export {
  MODERN_PROTOCOL, LEGACY_PROTOCOL, McpRpcError, McpTimeoutError, classifyProbe, encodeHeaderValue, standardHeaders,
  headerParams, paramHeaders,
} from './mcp/protocol.js';
export { toolHash, reviewServerTools, approveTools as approveMcpTools, forgetServerPins, pinsPath } from './mcp/pins.js';
export { isLiteralSecret, maskLiterals, moveLiteralSecrets, resolveConfigSecrets, migrateMcpSecrets } from './mcp/secrets.js';
export { McpSseClient } from './mcp/sse.js';

// -- Phase 1 of the agents/skills/tools design (scripts/phase1-skills-test.mjs) --
export {
  parseFrontmatter, parseYamlSubset, splitFrontmatter, updateFrontmatter, stringifyFrontmatter,
  composeMarkdown as composeSkillMarkdown, asList as fmList, asText as fmText,
} from './skills/frontmatter.js';
export { validateFrontmatter, referenceWarnings } from './skills/validate.js';
export {
  stageImport, installStaged, readStaged, discardStaged, reviewInstalled, reviewSkillFolder,
  claudeSkillMarkdown, stagingDir,
} from './skills/import.js';
export { readDirectory, extractArchive, packZip, ArchiveRefused, LIMITS as ARCHIVE_LIMITS } from './skills/archive.js';
export { scanSkillDir } from './skills/scan.js';
export { treeHash, readMeta, writeMeta, effectiveTrust, markReviewed, META_FILE } from './skills/provenance.js';
export { frontmatterOf } from './skills/loader.js';
export { catalogueBudgetTokens, CATALOGUE_MAX_TOKENS, CATALOGUE_ENTRY_MAX } from './tools/skill.js';

// -- Phase 5 of the agents/skills/tools design: skill generation (scripts/phase5-skill-author-test.mjs) --
export { readDraftEvals, hasEvals } from './skills/eval/evals-file.js';
export {
  measureSkill, planMeasure, splitTriggers, scoreTriggers, withSkillText, MAX_BUDGET_USD,
} from './skills/eval/measure.js';
export { readReport, evalGate, describeReport, REPORT_FILE } from './skills/eval/report.js';
export { listTree } from './skills/provenance.js';

// -- Phase 2 of the agents/skills/tools design: custom tools (scripts/phase2-custom-tools-test.mjs) --
export {
  validateDefinition, validateArgs, renderArgv, renderHttp, describeCall, parseSecretRef, providerSchema, fieldsOf,
} from './custom-tools/format.js';
export { runCustomTool, runProcess, spawnPlan, resolveWindowsProgram, secretFileRoot, runProbe } from './custom-tools/runner.js';
export { loadCustomTools, usableTools, setToolEnabled, userToolsDir, groupIdOf } from './custom-tools/store.js';
export { approvalDecision, installCustomToolGuards, taints, resetFirstUseForTest, approvalDetail } from './custom-tools/policy.js';
export { executeToolManage, toolsForPanel } from './custom-tools/manage.js';
export { projectToolFiles } from './workspace-trust.js';

// -- Phase 7: autonomy levels and the approve-later inbox (scripts/phase7-autonomy-test.mjs) --
export {
  AUTONOMY_LEVELS, parseLevel, minLevel, levelFromMode, modeFromLevel, effectiveLevel, levelLabel,
} from './autonomy/levels.js';
export {
  parkAction, listActions, getAction, approveAction, denyAction, expireDue, hashArgs, contextHashFor,
  outcomeMessage, inboxFile, resetInboxForTest, DEFAULT_PARK_TTL_MS,
} from './autonomy/inbox.js';
export { runPreview } from './custom-tools/policy.js';
export { defaultBackgroundLevel } from './background/index.js';
export { wakeDelivery } from './work/watchers.js';
// -- Phase 3: agents v2 (scripts/phase3-agents-test.mjs) --
export { parseAgentMarkdown, agentToMarkdown } from './agents/format.js';
export { validateAgentDef, validationContext, validateAgent } from './agents/validate.js';
export { summarizeAgent } from './agents/summary.js';
export { boundsOf } from './agents/resolve.js';
export { applyAutonomyCeiling } from './agents/ceiling.js';
export { globToRegExp, writeRefusal, installWritePathsGuard } from './agents/paths-guard.js';
export { listAgentSpecs, getAgentSpec } from './agents/registry.js';
export { BUILTIN_AGENT_FILES } from './agents/builtin.js';
export { agentRunScope } from './agent.js';
// -- Phase 4: verification and certification (scripts/phase4-certify-test.mjs) --
export { gradeCheck, gradeModelFree, gradeProcessCheck, snapshot, changedFiles, toolMatches, scoreOf } from './evals/grade.js';
export { safetyProbes, CANARY, DELETE_PATTERN, SAFETY_PACK_VERSION } from './evals/safety-pack.js';
export { BUILTIN_AGENT_TASKS } from './evals/builtin-tasks.js';
export { loadGoldenTasks, taskProblems, evalsFileFor } from './evals/tasks.js';
export { parseVerdict, judge, DEFAULT_JUDGE_MODEL } from './evals/judge.js';
export { runTrial, evalLevel } from './evals/run.js';
export { certifyAgent, planCertification, describeCertificate, clampBudget, MAX_CERTIFY_USD } from './evals/certify.js';
export {
  dependencyHash, statusOfSpec, certificationStatus, isCertified, listCertificates, writeCertificate, certificatesDir,
} from './evals/certificate.js';
export { spawnBackgroundAgent, getBackgroundAgents } from './background/index.js';

// Long jobs (longjob/, tools/long-job.ts).
export {
  propose as proposeLongJob, decide as decideLongJob, control as controlLongJob, afterTurn as afterLongJobTurn,
  listJobs as listLongJobs, getJob as getLongJob, pendingJob, activeJob, isLongEstimate, thresholdHours,
  recordMilestone, resumeAfterRestart, setLongJobHost, renderReport as renderLongJobReport, reportFile as longJobReportFile,
  longJobsDir, NO_PROGRESS_TURNS, subAgentMaxMs,
} from './longjob/index.js';
export { longJobTool, longJobDefinition } from './tools/long-job.js';

// The Sentinel (sentinel/, ADR 0015): scripts/sentinel-test.mjs and scripts/sentinel-eval.mjs.
export {
  sentinelTrigger, sentinelActive, tightenOnlySentinel, defaultSentinelModel, buildReviewInput, parseSentinelReply,
  redactForReview, SENTINEL_SYSTEM, DEFAULT_SENTINEL_TIMEOUT_MS, installSentinel, reviewCall, listSentinelVerdicts,
  sentinelFile, userRequestsOf, mergeRequests, recentCallsOf, untrustedSourcesOf, HUMAN_APPROVED, setSentinelReviewerForTest,
} from './sentinel/index.js';

// The morning brief and monitors (brief/): scripts/brief-test.mjs.
export * as brief from './brief/core.js';
export * as briefCollect from './brief/collect.js';
export * as briefService from './brief/service.js';

// Preference learning (learning/signals, preferences, distill; ADR 0016): scripts/preferences-test.mjs.
export {
  detectCorrections, detectChoices, summariseEdit, signalsFromTurn, feedbackSignal, rememberAgentWrites, userEditSignals,
  canvasEditSignal, queueSignals, readPendingSignals, consumeSignals, tallyChoices, scrub as scrubSignal, languageOf, makeSignal,
  signalsFile, EDIT_WINDOW_MS,
} from './learning/signals.js';
export {
  loadStore as loadPreferenceStore, saveStore as savePreferenceStore, listRules as listPreferenceRules, mergeCandidates,
  applyRuleAction, selectRules, renderRules, preferencesForTask, sanitiseRuleText, isLowRiskStyle, topicOf, normaliseScope,
  contextLanguages, sameRule, rulesFile as preferenceRulesFile, RULES_TOKEN_BUDGET,
} from './learning/preferences.js';
export {
  parseDistillReply, buildDistillRequest, fallbackCandidates, distillPending, DISTILL_SYSTEM, modelCompleter,
  afterTurn as preferencesAfterTurn, afterFeedback as preferencesAfterFeedback, beforeTurn as preferencesBeforeTurn,
} from './learning/distill.js';

// Model roles (models/roles, models/vision; ADR 0017): scripts/model-roles-test.mjs.
export {
  resolveRole, resolveAllRoles, ROLES, ROLE_IDS, roleInfo, cheapModelFor, roleForAgentType, backgroundModel,
  dropProjectModelChoices, rolePrice, recordRoleSpend, roleSpend, resetRoleSpend,
} from './models/roles.js';
export {
  visionDescriber, describeImagesWith, describedImageNote, clearVisionCache, VISION_SYSTEM, VISION_MAX_TOKENS,
} from './models/vision.js';
export { distillModel } from './learning/distill.js';
export { defaultJudgeModel } from './evals/judge.js';

// About you (profile/; ADR 0018): scripts/profile-test.mjs.
export * as profile from './profile/index.js';

// The Tasks panel (work/tasks, shared/tasks): scripts/tasks-test.mjs.
export {
  tasksSnapshot, subscribeTasks, setTaskAsksProvider, startTaskTracking, resetTasksForTest, clean as cleanTaskText,
} from './work/tasks.js';
export { processInfo } from './work/register.js';
export * as sharedTasks from '../shared/tasks.js';
// -- Background agents that report back (ADR 0021) --
export {
  resumeTask, stopSessionAgents, agentResumeSpec, normalizeAgentId, RESUME_AFTER_RESTART,
} from './tools/task.js';
export {
  setReportBackDelivery, reportBack, recentReports, rememberSessionInbox, boundReport, wakeOnResult,
  WAKE_TASK, REPORT_MAX_CHARS,
} from './agents/report-back.js';
export {
  acquireSlot, releaseSlot, suspendSlot, resumeSlot, slotState, maxConcurrentFrom, resetLimiterForTest,
  DEFAULT_MAX_CONCURRENT,
} from './agents/limiter.js';
export { serializeScope, deserializeScope, intersectScopes } from './agents/scope-json.js';
export { interruptedAgents, autoResumable, resumeAgentFromOutside, resumeInterruptedAgents } from './agents/background.js';
export { worktreeManager, describeWorktreeFinish } from './worktree/index.js';
export { executeEnterWorktree, executeExitWorktree } from './worktree/tools.js';
export { backgroundExitNotice } from './tools/bash.js';
export { isSubAgentSessionId } from './session/persistence.js';
// -- AICO Slides (decks), ADR 0023 --
export * as DeckModel from '../shared/ui/canvas/deck-model.js';
export * as DeckLayout from '../shared/ui/canvas/deck-layout.js';
export * as DeckThemes from '../shared/ui/canvas/deck-themes.js';
export * as DeckTypes from '../shared/ui/canvas/deck-types.js';
export * as DeckRender from '../shared/ui/canvas/deck-render.js';
export { textWidth as deckTextWidth } from '../shared/ui/canvas/deck-fonts.js';
export { toPptx, chartXml as deckChartXml, imageSize, nativeChart } from './canvas/deck-pptx.js';
export { exportDeck, deckHtml, deckChartSvg, DECK_EXPORT_FORMATS } from './canvas/deck-export.js';
export { createDeck, setSlides, readDeck, DECK_TOOL_HELP } from './canvas/deck-tool.js';
// -- Deck visual system, ADR 0025 --
export * as DeckGeometry from '../shared/ui/canvas/deck-geometry.js';
export * as DeckDecor from '../shared/ui/canvas/deck-decor.js';
export * as DeckIcons from '../shared/ui/canvas/deck-icons.js';
export * as DeckInfographics from '../shared/ui/canvas/deck-infographics.js';
export * as DeckRules from '../shared/ui/canvas/deck-rules.js';
export { custGeom as deckCustGeom, creditLines as deckCreditLines } from './canvas/deck-pptx.js';
export * as DeckDesign from '../shared/ui/canvas/deck-design.js';
export * as DeckMedia from './canvas/deck-media.js';
export * as DeckMediaStore from './canvas/deck-media-store.js';
export * as DeckImageSearch from './canvas/deck-image-search.js';
export * as DeckBrand from './canvas/deck-brand.js';
export { DECK_VISUAL_HELP } from './canvas/deck-visual-tool.js';
export { handleDeckVisualRoute, projectPictures } from './server/deck-visual-routes.js';
// -- Secrets kept out of the agent's children and sinks --
export { agentChildEnv, mcpServerEnv, registerSettingsSecrets, PROVIDER_KEY_NAMES } from './child-env.js';
export { setExtraRedactions } from './vault/sink.js';
export { withholdDetected } from './vault/agent-hooks.js';
export { headersForHop } from './canvas/deck-media.js';
// -- Project settings policy, MCP guard/pins/spawn, keep-local roles (security-settings-test) --
export { PROJECT_POLICY, projectPolicyOf, filterProjectLayer, tightenProjectLayer } from './settings-project-policy.js';
export { miniAppHost } from './miniapps/server.js';
export { guardMcpText } from './mcp/base.js';
export { serverIdentity as mcpServerIdentity } from './mcp/pins.js';
export { windowsShellUnsafe as mcpWindowsShellUnsafe } from './mcp/stdio.js';
export { localOnlyRefusal, keepsDataLocal, isCloudModelTag } from './models/roles.js';
// -- Security review 2026-10: agent and tool fixes (scripts/security-fixes-test.mjs) --
export { shellCommandOf, normaliseShell } from './safety.js';
export { configWriteDenial, isAicoConfigFile } from './tools/config-write-guard.js';
export { looksLikeSecretPath } from './tools/git.js';
export { markTainted } from './run-context.js';
// -- Security review 2026-10: server fixes (scripts/security-server-test.mjs) --
export { isAllowedHost, isAllowedOrigin, publicErrorMessage, decideSubmitMode, submitRank } from './server/http-guards.js';
export { isValidSessionId } from './session/persistence.js';
// -- Shift-left security (ADR 0026): the agent's own security check (scripts/security-check-test.mjs) --
export { securityCheck } from './security/project-scan.js';
export { SECURITY_CHECK } from './tools/run-checks.js';
export { writtenFiles } from './checks.js';
export { setWebFetchTransportForTest } from './tools/webfetch.js';
// -- Security review 2026-10: D4/D5 watcher guards (scripts/security-pipeline-fixes-test.mjs, scripts/watcher-live.mjs) --
export { setWatcherFetcherForTest, watchCommandRefusal, watchUrlRefusal } from './work/watchers.js';
