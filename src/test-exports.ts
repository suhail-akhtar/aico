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
export { readMemory } from './memory/index.js';
export { runHooks, freezeHooks, resetHooks } from './hooks.js';
// Exports for the new-logic test suites
export { getOpenTodoCount, todoWrite, todoRead, retireTodos } from './tools/todo.js';
export {
  getModelCapabilities, modelAccepts, modelProduces, modelCanChat, explainRefusal,
  resetCapabilityCache, MODALITIES,
} from './model-capabilities.js';
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
export { Inbox } from './session/inbox.js';
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
export { listSessionSummaries } from './session/persistence.js';
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
export { observe, blockedReason, resetObservations, isObserved } from './tools/observation.js';
export { runScoped } from './run-scoped.js';
export { detectChecks, isSourceFile, resetChecks, noteSourceChanged, recordCheck, checkProjectGate, checkResults, newestSourceChange, touchedFiles } from './checks.js';
export { runChecks } from './tools/run-checks.js';
export { listChanges, diffOf, revertFile, isGitRepo } from './server/changes.js';
export { useSkill, skillCatalogue, skillDefinition, describeSize } from './tools/skill.js';
export { skillRegistry } from './skills/registry.js';
export { executeSkillCreate } from './skills/create.js';
export { executeSkillManage, verifySkillDir, draftsDir } from './skills/manage.js';
export { setEnabled, isDisabled, disabledIn, registryStatePath } from './registry-state.js';
export { matchingSkills } from './tools/skill.js';
export { executeAgentManage } from './tools/manage-agents.js';
export { resolveAgent, inlineSkills, personaFor } from './agents/resolve.js';
export { currentAgent, currentModel } from './session/projections.js';
export { executeMemoryManage } from './tools/manage-memory.js';
export { executeMcpManage, splitCommandLine, parseMcpConfig } from './mcp/manage-tool.js';
export { remember, listScope, applicable, activeMemories, memoryRoot, scopeDir, searchMemories, setMemoryEnabled, memoryKey } from './memory/store.js';
export { updateMcpServer } from './mcp/manage.js';
export { buildRuntimeAwareness } from './capabilities.js';
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
} from './checkpoint/index.js';
export { investigate, investigateDefinition, findDuplicateAngles } from './tools/investigate.js';
export { getWidgetSpec, widgetSpecDefinition } from './tools/widget-spec.js';
export {
  WIDGET_CATALOG, widgetForLanguage, widgetById, catalogLines,
} from '../shared/widgets/catalog.js';
export { DIAGRAM_TYPES, diagramType, diagramIndex } from '../shared/widgets/diagram-types.js';
export { selectToolProfile } from './agent.js';
export {
  owningSession, registerOwnerForTest, requestAgentStop, guideAgent, detachedRun,
  taskToolDefinition, runTask, getAgentRegistry,
} from './tools/task.js';
export { executeSupervise, superviseToolDefinition } from './tools/supervise.js';
export { loadSettings } from './settings.js';
export { createMiniApp, miniAppDir, getMiniApp, listMiniApps } from './miniapps/store.js';
export { miniAppContext } from './miniapps/context.js';
export { runAgent } from './agent.js';
export {
  scrubbedEnv, startApp, stopApp, appState, runningApps, subscribeToApps,
} from './miniapps/process.js';
export { nextAuthoringContract } from './miniapps/contract-nextjs.js';
export { splitStatements } from './miniapps/data.js';
export { executeMiniAppManage } from './tools/manage-miniapps.js';
export { authoringContract } from './miniapps/contract.js';
