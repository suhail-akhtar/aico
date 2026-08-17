import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text, useApp, useInput, render, Static } from 'ink';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { AicoSettings } from '../settings.js';
import { runAgent } from '../agent.js';
import { handleSlashCommand } from '../commands.js';
import { createTokenTracker } from '../tokens.js';
import { loadTrust, saveTrust } from '../trust.js';
import { appendMessage } from '../history.js';
import { maybeAutoCompactConversation } from '../compact.js';
import { maybeCompactSession, type Session as AicoSession } from '../session/index.js';

/**
 * Compact whichever store the model actually reads.
 *
 * With a session log attached the request is derived from the log, so trimming
 * the plain message array would shrink something nothing reads while the real
 * context kept growing. The array is still trimmed on the legacy path.
 */
function compactActiveContext(
  history: Array<{ role: string; content: string }>,
  settings: AicoSettings,
  model: string,
  session?: AicoSession,
): void {
  if (session) {
    maybeCompactSession(session, settings, model);
    return;
  }
  maybeAutoCompactConversation(history, settings, model);
}
import { runPipeline } from '../studio/pipeline.js';
import { readState } from '../studio/state.js';
import { createStudioRuntime } from '../studio/runtime.js';
import type { Todo } from '../tools/todo.js';
import {
  readClipboardImage,
  resolveFileAttachment,
  parseAttachTokens,
  type ResolvedAttachment,
  type SdkAttachment,
} from '../attachments.js';
import { Panel } from './panels/Panel.js';
import { BackgroundAgentsPanel } from './panels/BackgroundAgentsPanel.js';
import { WorktreePanel } from './panels/WorktreePanel.js';
import { ScheduledTasksPanel } from './panels/ScheduledTasksPanel.js';
import type { BackgroundAgentRecord } from '../background/index.js';
import type { WorktreeRecord } from '../worktree/index.js';
import type { CronJob } from '../cron/types.js';
import type { McpServerInfo } from '../mcp/registry.js';

const execFileAsync = promisify(execFile);

// ── Claude Code-style visual identity ─────────────────────────────
// Coral/orange accent — the signature Claude Code brand color (~#FF6B35)
const CORAL = '#FF6B35';

// ── Dynamic context window ──────────────────────────────────────────
// Context windows are now dynamically detected from the provider's
// model-info endpoint on first interaction and persisted to settings.
// See src/context-window.ts for the full detection pipeline.
import { getContextWindow } from '../context-window.js';

// ── Theme system ──────────────────────────────────────────────────
// Color tokens that adapt to the terminal background. Claude Code offers 7
// themes; we start with dark (default) and light. The theme is read from
// settings.theme ('dark' | 'light' | 'auto'). Colors are used via the token,
// not hardcoded, so switching themes changes the whole UI.
interface ThemeTokens {
  accent: string;       // coral/orange for markers, tool headers, brand
  primary: string;      // main text (white in dark, black in light)
  muted: string;        // secondary text (dim)
  success: string;      // green for additions, pass, yes
  danger: string;       // red for errors, removals, no
  info: string;         // cyan for links, info
  warning: string;      // yellow for warnings
  codeBlock: string;    // green for code fence content
}

const THEMES: Record<string, ThemeTokens> = {
  dark: {
    accent: '#FF6B35',
    primary: 'white',
    muted: 'gray',
    success: 'green',
    danger: 'red',
    info: 'cyan',
    warning: 'yellow',
    codeBlock: 'green',
  },
  light: {
    accent: '#D4501E',      // slightly darker coral for light backgrounds
    primary: 'black',
    muted: 'gray',
    success: 'green',
    danger: 'red',
    info: 'cyan',
    warning: 'yellow',
    codeBlock: 'blue',
  },
};

// Resolve the active theme from settings (default: dark)
function getTheme(settings?: { theme?: string }): ThemeTokens {
  const name = settings?.theme ?? 'dark';
  return THEMES[name] ?? THEMES.dark;
}

// Claude Code's spinner: teardrop asterisk cycle (reverse-engineered)
const SPINNER_FRAMES = ['·', '✻', '✽', '⋄', '⋆', '✶'];

// Rotating verb pool for the spinner (Claude Code cycles these)
const SPINNER_VERBS = ['Thinking', 'Pondering', 'Working', 'Processing', 'Analyzing', 'Cogitating'];

// Assistant message marker (U+23FA — the record dot Claude Code uses)
const ASSISTANT_MARKER = '⏺';

// ── Types ──────────────────────────────────────────────────────────

/** Committed history entry — rendered once via Static, never mutated */
interface HistoryEntry {
  type: 'user' | 'assistant' | 'tool_done' | 'system' | 'error';
  content: string;
  detail?: string;
  toolName?: string;
}

/** Live operation during active agent run */
interface LiveOp {
  id: number;
  name: string;
  label: string;
  status: 'running' | 'done';
  detail?: string;
}

interface PermissionRequest {
  toolName: string;
  detail: string;
  /** For Edit/Write: a preview diff to show before approval */
  fileDiff?: { path: string; added?: string[]; removed?: string[]; preview?: string };
  resolve: (allowed: boolean) => void;
}

interface AskUserRequest {
  question: string;
  resolve: (answer: string) => void;
}

export interface InkAppProps {
  model: string;
  autoApprove: boolean;
  verbose: boolean;
  sessionId: string;
  filePath?: string;
  showPlan: boolean;
  settings: AicoSettings;
  cwd: string;
  resumedHistory?: Array<{ role: string; content: string }>;
  sessionName?: string;
  /** Effort level passed from CLI (low | medium | high | max) */
  effort?: string;
  /**
   * Durable session log. When present, every model request is derived from it
   * rather than from a flattened history string, so tool calls and results
   * survive across turns. `resumedHistory` is still kept for rendering the
   * scrollback and for the commands that operate on plain message pairs.
   */
  session?: import('../session/index.js').Session;
  /**
   * Durable input queue. When present, typing while the agent is working steers
   * the running turn instead of queueing behind the whole run.
   */
  inbox?: import('../session/index.js').Inbox;
}

// ── Utilities ──────────────────────────────────────────────────────

/** Get the current git branch name, or null if not in a git repo */
async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['branch', '--show-current'],
      { cwd, timeout: 2_000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Build the per-turn effort hint identical to the one in index.ts */
function buildEffortHint(effort: string | undefined): string {
  if (!effort || effort === 'medium') return '';
  const hints: Record<string, string> = {
    low: 'Be concise and fast. Prefer the simplest working solution.',
    high: 'Be thorough and detailed. Explore edge cases and document your work.',
    max: 'Use maximum effort. Explore all options exhaustively. Leave nothing unchecked.',
  };
  const hint = hints[effort] ?? '';
  return hint ? `\n\n[Effort: ${effort}. ${hint}]` : '';
}

// ── Spinner component (Claude Code style: coral ✻ with rotating verbs) ─
function Spinner({ label }: { label: string }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 100);
    return () => clearInterval(id);
  }, []);
  const frame = SPINNER_FRAMES[tick % SPINNER_FRAMES.length];
  // Rotate the verb from the pool every ~3 seconds (30 ticks at 100ms)
  const verb = SPINNER_VERBS[Math.floor(tick / 30) % SPINNER_VERBS.length];
  // If the label is a custom tool status, use it; otherwise use the rotating verb
  const displayLabel = label === 'Thinking…' ? `${verb}…` : label;
  return (
    <Box>
      <Text color={CORAL}>{frame} </Text>
      <Text dimColor>{displayLabel}</Text>
    </Box>
  );
}

// ── Tool call box (Claude Code-style rounded panel) ───────────────
function ToolCallBox({ name, content, detail }: { name: string; content: string; detail?: string }) {
  const preview = detail || content;
  // For Edit/Write, try to show a colored diff preview
  const isEdit = name === 'Edit' || name === 'Write' || name === 'MultiEdit';
  const icon = TOOL_GLYPHS[name] || '🔧';
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={CORAL} paddingX={1} marginY={0}>
      <Box>
        <Text color={CORAL}>{icon} </Text>
        <Text bold color={CORAL}>{name}</Text>
        <Text dimColor> {content.slice(0, 60)}</Text>
      </Box>
      {preview && preview !== content && (
        <Box>
          <Text dimColor>  {preview.slice(0, 100)}</Text>
        </Box>
      )}
      {isEdit && detail && (
        <Box>
          <Text color="green">  + changes applied</Text>
        </Box>
      )}
    </Box>
  );
}

// Tool glyph icons for the visual tool call boxes
const TOOL_GLYPHS: Record<string, string> = {
  Bash: '⚡', Read: '📖', Write: '✏️', Edit: '✏️', Glob: '🔍', Grep: '🔎',
  LS: '📁', WebFetch: '🌐', WebSearch: '🌐', Task: '🤖', TodoWrite: '📋',
  TodoRead: '📋', NotebookEdit: '📝', Pwd: '📍', AskUserQuestion: '❓',
};

// ── Committed history entry ────────────────────────────────────────
function HistoryLine({ entry }: { entry: HistoryEntry }) {
  if (entry.type === 'user') {
    return (
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color="green" bold>{'❯ '}</Text>
          <Text bold>{entry.content}</Text>
        </Box>
      </Box>
    );
  }
  if (entry.type === 'assistant') {
    return (
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={CORAL}>{ASSISTANT_MARKER + ' '}</Text>
          <MarkdownText content={entry.content} />
        </Box>
      </Box>
    );
  }
  // Tool call: render as a Claude Code-style rounded box with the tool name
  // in the header and the detail as body content
  if (entry.type === 'tool_done') {
    return (
      <Box flexDirection="column" marginTop={0}>
        <ToolCallBox name={entry.toolName || 'Tool'} content={entry.content} detail={entry.detail} />
      </Box>
    );
  }
  if (entry.type === 'error') {
    return (
      <Box>
        <Text color="red">{'✗ '}</Text>
        <Text color="red">{entry.content}</Text>
      </Box>
    );
  }
  // system
  return (
    <Box>
      <Text dimColor>{entry.content}</Text>
    </Box>
  );
}

// ── Live ops panel ─────────────────────────────────────────────────
// Progressive streaming markdown + live tool list + spinner.
// Shows streaming text rendered as markdown (not truncated to 80 chars),
// any currently-running tools, and the spinner with rotating verbs.
function LiveOpsPanel({
  spinnerLabel,
  isThinking,
  streamingText,
  liveOps,
}: {
  spinnerLabel: string;
  isThinking: boolean;
  streamingText: string;
  liveOps: LiveOp[];
}) {
  if (!isThinking) return null;

  // Progressive markdown rendering: show the last ~15 lines of streamed text,
  // rendered through the markdown renderer. This is what makes the UI feel
  // alive — the user sees formatted text appearing in real time.
  const streamingLines = streamingText ? streamingText.split('\n').slice(-15) : [];

  return (
    <Box flexDirection="column">
      {/* Streaming markdown preview (up to 15 lines, rendered as markdown) */}
      {streamingLines.length > 0 ? (
        <Box flexDirection="column">
          <Box>
            <Text color={CORAL}>{ASSISTANT_MARKER} </Text>
            {streamingLines.length === 1 && streamingLines[0].length < 80 ? (
              // Single short line — render inline with cursor
              <>
                <Text dimColor>{streamingLines[0]}</Text>
                <Text color={CORAL} bold>▋</Text>
              </>
            ) : (
              // Multi-line — render through markdown for progressive formatting
              <MarkdownText content={streamingLines.join('\n')} />
            )}
          </Box>
        </Box>
      ) : null}

      {/* Live tool list: show currently-running tools (L4) */}
      {liveOps.filter(op => op.status === 'running').slice(0, 5).map(op => (
        <Box key={op.id} marginLeft={2}>
          <Text color={CORAL}>{SPINNER_FRAMES[Date.now() % SPINNER_FRAMES.length]} </Text>
          <Text dimColor>{op.label}</Text>
        </Box>
      ))}

      {/* Spinner with rotating verb */}
      <Spinner label={spinnerLabel} />
    </Box>
  );
}

// ── Permission Prompt (with diff preview for Edit/Write) ──────────
function PermissionPrompt({ req, onRespond }: {
  req: PermissionRequest;
  onRespond: (allowed: boolean, all?: boolean) => void;
}) {
  useInput((input, key) => {
    if (key.escape || input === 'n' || input === 'N') onRespond(false);
    else if (input === 'y' || input === 'Y') onRespond(true);
    else if (input === 'a' || input === 'A') onRespond(true, true);
    else if (input === 'd' || input === 'D') onRespond(false, true);
  });

  const isEdit = req.toolName === 'Edit' || req.toolName === 'Write' || req.toolName === 'MultiEdit';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={CORAL} paddingX={2} marginY={1}>
      <Text color={CORAL} bold>{'⚠ Allow ' + req.toolName + '?'}</Text>

      {/* Tool name and args */}
      <Box marginTop={1}>
        <Text dimColor>{'  '}</Text>
        <Text bold color="cyan">{req.toolName}</Text>
        {req.detail ? <Text dimColor>{' ' + req.detail.slice(0, 100)}</Text> : null}
      </Box>

      {/* Diff preview for Edit/Write — shows what will change before approval */}
      {isEdit && req.fileDiff && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor bold>{'  ┌─ ' + (req.fileDiff.path || 'file') + ' ─'}</Text>
          {req.fileDiff.removed?.slice(0, 5).map((line, i) => (
            <Text key={'r' + i} color="red">{'  - ' + line.slice(0, 100)}</Text>
          ))}
          {req.fileDiff.added?.slice(0, 5).map((line, i) => (
            <Text key={'a' + i} color="green">{'  + ' + line.slice(0, 100)}</Text>
          ))}
          {!req.fileDiff.added?.length && !req.fileDiff.removed?.length && req.fileDiff.preview && (
            <Text dimColor>{'  ' + req.fileDiff.preview.slice(0, 100)}</Text>
          )}
        </Box>
      )}

      {/* Key bindings */}
      <Box marginTop={1}>
        <Text dimColor>  [</Text><Text color="green" bold>y</Text>
        <Text dimColor>] Yes  [</Text><Text color="green" bold>a</Text>
        <Text dimColor>] Always  [</Text><Text color="red" bold>n</Text>
        <Text dimColor>] No  [</Text><Text color="red" bold>d</Text>
        <Text dimColor>] Never</Text>
      </Box>
    </Box>
  );
}

// ── AskUser Prompt ─────────────────────────────────────────────────
function AskUserPrompt({ req, onAnswer }: {
  req: AskUserRequest;
  onAnswer: (answer: string) => void;
}) {
  const [val, setVal] = useState('');
  const { cursor } = useTextInput({
    value: val,
    onChange: setVal,
    onSubmit: (v) => onAnswer(v.trim()),
    isActive: true,
  });
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={2}
      marginY={1}
    >
      <Text color="cyan" bold>{'◇ '}{req.question}</Text>
      <Box marginTop={1}>
        <InputDisplay value={val} cursor={cursor} placeholder="Your answer…" />
      </Box>
    </Box>
  );
}

// ── Todo Panel ─────────────────────────────────────────────────────
function TodoPanel({ todos }: { todos: Todo[] }) {
  if (!todos.length) return null;
  const icon = (s: string) =>
    s === 'done' ? '◆' : s === 'in_progress' ? '◐' : s === 'cancelled' ? '✗' : '◇';
  const col = (s: string) =>
    s === 'done' ? 'gray' : s === 'in_progress' ? 'yellow' : s === 'cancelled' ? 'red' : 'white';
  return (
    <Box flexDirection="column" marginTop={1}>
      {todos.slice(0, 8).map((t, i) => (
        <Box key={i}>
          <Text color={col(t.status)}>{icon(t.status)} </Text>
          <Text
            color={col(t.status) as any}
            dimColor={t.status === 'done'}
          >
            {t.title.slice(0, 65)}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

// ── Sub-Agents Panel ───────────────────────────────────────────────
const AGENT_COLORS = ['cyan', 'green', 'magenta', 'blue', 'yellow', 'red'] as const;

interface SubAgentRec {
  agentId: string;
  description: string;
  model: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  statusMessage: string;
  startedAt: number;
  completedAt?: number;
  depth: number;
  agentType?: string;
  lastActivityAt?: number;
  toolCallCount?: number;
  currentTool?: string;
  /** Cumulative token consumption (mirrored from SubAgentRecord) */
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

function shortModelName(model: string): string {
  const tail = model.split('/').pop() ?? model;
  return tail
    .replace(/^claude-/, '')
    .replace(/^deepseek-/, 'ds-')
    .replace(/-latest$/, '')
    .replace(/:nitro$/, '')
    .replace(/-\d+.*$/, '')
    .slice(0, 8);
}

function AgentsPanel({
  agents,
  selectedIndex,
  showDetail,
  isFocused,
}: {
  agents: SubAgentRec[];
  selectedIndex: number;
  showDetail: boolean;
  isFocused: boolean;
}) {
  const [frame, setFrame] = useState(0);
  const [, forceRender] = useState(0); // force re-render to keep elapsed times current

  const running = agents.filter(a => a.status === 'running');

  // 80ms matches the braille spinner cadence used by all panels and Claude Code CLI
  useEffect(() => {
    if (!running.length && !isFocused) return;
    const id = setInterval(() => {
      setFrame(f => (f + 1) % SPINNER_FRAMES.length);
      forceRender(n => n + 1);
    }, 80);
    return () => clearInterval(id);
  }, [running.length, isFocused]);

  if (!agents.length) return null;

  // Group: studio pipeline agents (Phase N / studio-*) vs. regular sub-agents
  const studioAgents = agents.filter(a =>
    a.description.startsWith('Phase ') || a.agentType?.startsWith('studio'),
  );
  const otherAgents = agents.filter(a =>
    !a.description.startsWith('Phase ') && !a.agentType?.startsWith('studio'),
  );
  const allAgents = [...studioAgents, ...otherAgents];

  const formatElapsed = (a: SubAgentRec) => {
    const ms = (a.completedAt ?? Date.now()) - a.startedAt;
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
  };

  // Format token count as compact "↓1.2k" / "↓0.5k" style (Claude Code bottom panel)
  const formatTokens = (input?: number, output?: number): string => {
    const total = (input ?? 0) + (output ?? 0);
    if (total < 1_000) return '';
    if (total < 1_000_000) {
      const k = (total / 1000).toFixed(total < 10_000 ? 1 : 0);
      return `${k}k`;
    }
    return `${(total / 1_000_000).toFixed(1)}M`;
  };

  const heartbeatChar = (a: SubAgentRec): { sym: string; color: string } => {
    if (a.status !== 'running' || !a.lastActivityAt) return { sym: '', color: 'gray' };
    const idle = Date.now() - a.lastActivityAt;
    if (idle < 5_000)  return { sym: '●', color: 'green' };
    if (idle < 30_000) return { sym: '◐', color: 'yellow' };
    return { sym: '○', color: 'red' };
  };

  // ── Detail view: expanded information for the selected operation ──
  const renderDetail = (agent: SubAgentRec) => {
    const elapsed = formatElapsed(agent);
    const tc = agent.toolCallCount ?? 0;
    const inpT = agent.inputTokens ?? 0;
    const outT = agent.outputTokens ?? 0;
    const cacheT = agent.cachedTokens ?? 0;
    const totalT = inpT + outT;

    return (
      <Box flexDirection="column" marginTop={0}>
        <Box>
          <Text dimColor>{'  '}</Text>
          <Text bold color={CORAL}>┌─ {agent.description} </Text>
          <Text dimColor>─</Text>
        </Box>
        <Box>
          <Text dimColor>{'  │ '}</Text>
          <Text dimColor>status: </Text>
          <Text bold color={
            agent.status === 'running' ? 'yellow' :
            agent.status === 'completed' ? 'green' :
            agent.status === 'failed' ? 'red' : 'gray'
          }>{agent.status}</Text>
          <Text dimColor>  ·  model: </Text>
          <Text dimColor>{agent.model}</Text>
          <Text dimColor>  ·  type: </Text>
          <Text dimColor>{agent.agentType ?? 'general'}</Text>
        </Box>
        <Box>
          <Text dimColor>{'  │ '}</Text>
          <Text dimColor>elapsed: </Text>
          <Text dimColor>{elapsed}</Text>
          <Text dimColor>  ·  tool calls: </Text>
          <Text dimColor>{tc}</Text>
          <Text dimColor>  ·  depth: </Text>
          <Text dimColor>{agent.depth}</Text>
        </Box>
        <Box>
          <Text dimColor>{'  │ '}</Text>
          <Text dimColor>tokens: </Text>
          <Text color="cyan">↓{inpT.toLocaleString()}</Text>
          <Text dimColor> in </Text>
          <Text color="green">↑{outT.toLocaleString()}</Text>
          <Text dimColor> out</Text>
          {cacheT > 0 && (
            <>
              <Text dimColor>  ·  </Text>
              <Text color="magenta" dimColor>{cacheT.toLocaleString()} cached</Text>
            </>
          )}
          {totalT > 0 && (
            <>
              <Text dimColor>  ·  </Text>
              <Text bold color={CORAL}>{formatTokens(inpT, outT)} total</Text>
            </>
          )}
        </Box>
        {agent.statusMessage && agent.status === 'running' && (
          <Box>
            <Text dimColor>{'  │ '}</Text>
            <Text dimColor>current: </Text>
            <Text dimColor>{agent.statusMessage}</Text>
          </Box>
        )}
        {agent.status !== 'running' && (
          <Box>
            <Text dimColor>{'  │ '}</Text>
            <Text dimColor>press ← or Esc to return to operations list</Text>
          </Box>
        )}
        <Box>
          <Text dimColor>{'  └'}</Text>
          <Text dimColor>{'─'.repeat(Math.min(agent.description.length + 4, 50))}</Text>
        </Box>
      </Box>
    );
  };

  const renderAgent = (agent: SubAgentRec, i: number, indent = 0) => {
    const color    = AGENT_COLORS[i % AGENT_COLORS.length];
    const elapsed  = formatElapsed(agent);
    const hb       = heartbeatChar(agent);
    const tc       = agent.toolCallCount ?? 0;
    const tokenStr = formatTokens(agent.inputTokens, agent.outputTokens);

    const icon = agent.status === 'running'
      ? SPINNER_FRAMES[frame % SPINNER_FRAMES.length]
      : agent.status === 'completed' ? '✓'
      : agent.status === 'failed'    ? '✗' : '○';

    const iconColor = agent.status === 'running'   ? color
      : agent.status === 'completed' ? 'green'
      : agent.status === 'failed'    ? 'red' : 'gray';

    const modelShort = shortModelName(agent.model);
    const isSelected = i === selectedIndex && (isFocused || showDetail);

    return (
      <Box key={agent.agentId} flexDirection="row">
        {/* Selection arrow / tree indent */}
        <Box width={indent > 0 ? 5 : 2}>
          {isSelected
            ? <Text color={CORAL} bold>{'▶'}</Text>
            : indent > 0
              ? <Text dimColor>{'  └─ '}</Text>
              : <Text> </Text>}
        </Box>

        {/* Status icon */}
        <Box width={2}><Text color={iconColor}>{icon}</Text></Box>

        {/* Description — left-aligned, 34 chars (slightly narrower to fit tokens) */}
        <Box width={34}>
          <Text
            color={isSelected ? CORAL : (color as any)}
            bold={isSelected}
            wrap="truncate"
          >
            {agent.description}
          </Text>
        </Box>

        {/* Model name */}
        <Box width={8}><Text dimColor wrap="truncate">{modelShort}</Text></Box>

        {/* Token consumption — ↓1.2k style (Claude Code concurrent ops panel) */}
        <Box width={8}>
          {tokenStr
            ? <Text color="cyan" dimColor>{`↓${tokenStr}`}</Text>
            : <Text> </Text>}
        </Box>

        {/* Elapsed time */}
        <Box width={6}><Text dimColor>{elapsed}</Text></Box>

        {/* Op count + heartbeat */}
        {tc > 0 && <Text dimColor>({tc}ops)</Text>}
        {hb.sym && <Text color={hb.color as any}> {hb.sym}</Text>}
      </Box>
    );
  };

  // Build panel title: "Agents (3) · 2 active · 1 done"
  const runningCount = agents.filter(a => a.status === 'running').length;
  const doneCount    = agents.filter(a => a.status === 'completed').length;
  const failedCount  = agents.filter(a => a.status === 'failed').length;

  // Aggregate token consumption across all visible agents
  const totalInput = allAgents.reduce((sum, a) => sum + (a.inputTokens ?? 0), 0);
  const totalOutput = allAgents.reduce((sum, a) => sum + (a.outputTokens ?? 0), 0);
  const totalTokenStr = formatTokens(totalInput, totalOutput);

  const headerParts = [`Agents (${agents.length})`];
  if (runningCount > 0) headerParts.push(`${runningCount} active`);
  if (doneCount > 0)    headerParts.push(`${doneCount} done`);
  if (failedCount > 0)  headerParts.push(`${failedCount} failed`);
  if (totalTokenStr)    headerParts.push(`↓${totalTokenStr} tokens`);

  // ── Column header ──
  const columnHeader = (
    <Box flexDirection="row">
      <Text dimColor>{'  '}</Text>
      <Box width={2}><Text dimColor bold>{' '}</Text></Box>
      <Box width={34}><Text dimColor bold>{'operation'}</Text></Box>
      <Box width={8}><Text dimColor bold>{'model'}</Text></Box>
      <Box width={8}><Text dimColor bold>{'tokens'}</Text></Box>
      <Box width={6}><Text dimColor bold>{'time'}</Text></Box>
      <Text dimColor bold>{'ops'}</Text>
    </Box>
  );

  // ── Detail view for selected operation ──
  if (showDetail && allAgents[selectedIndex]) {
    const agent = allAgents[selectedIndex];
    return (
      <Panel title={headerParts.join(' · ')} borderColor={CORAL}>
        {renderDetail(agent)}
      </Panel>
    );
  }

  // Panel handles the ╭─ Title ─────╮ border style — no internal separator needed
  return (
    <Panel title={headerParts.join(' · ')} borderColor={isFocused ? CORAL : 'gray'}>
      {columnHeader}
      {studioAgents.map((agent, i) => renderAgent(agent, i))}
      {otherAgents.map((agent, i) =>
        renderAgent(agent, studioAgents.length + i, studioAgents.length > 0 ? 1 : 0),
      )}
      {isFocused && (
        <Box marginTop={0}>
          <Text dimColor>{'  ↑↓ scroll · → or ↵ select · ← or Esc back to input'}</Text>
        </Box>
      )}
    </Panel>
  );
}

// Module-level callback so the raw stdin handler (registered in AicoApp)
// can trigger "insert newline" in whichever useTextInput is currently active.
const _shiftEnterGlobal: { fn: (() => void) | null } = { fn: null };

// ── Slash command metadata (for autocomplete) ─────────────────────
const SLASH_COMMANDS = [
  { name: '/help',             desc: 'Show all available commands' },
  { name: '/compact',          desc: 'Compress history to free context' },
  { name: '/clear',            desc: 'Clear conversation history' },
  { name: '/model',            desc: 'Show or switch model' },
  { name: '/status',           desc: 'Show session info and tokens' },
  { name: '/cost',             desc: 'Show token usage and estimated cost' },
  { name: '/permissions',      desc: 'Manage session tool trust' },
  { name: '/config',           desc: 'Show or edit AICO settings' },
  { name: '/review',           desc: 'Run code review agents' },
  { name: '/studio',           desc: 'Autonomous SDLC build in workspace' },
  { name: '/memory',           desc: 'Show loaded memory files' },
  { name: '/memory add',       desc: 'Append text to project AICO.md' },
  { name: '/memory types',     desc: 'Show memory cache stats' },
  { name: '/history',          desc: 'List recent sessions' },
  { name: '/resume',           desc: 'Resume a previous session by ID' },
  { name: '/init',             desc: 'Create AICO.md memory file' },
  { name: '/doctor',           desc: 'Check environment & settings' },
  { name: '/agents',           desc: 'List specialist agents' },
  { name: '/agents show',      desc: 'Inspect an agent' },
  { name: '/agents delete',    desc: 'Delete a project agent' },
  { name: '/agents skills',    desc: 'Set agent skills' },
  { name: '/agent-create',     desc: 'Create reusable custom agent' },
  { name: '/agent',            desc: 'Chat with one specialist agent' },
  { name: '/team',             desc: 'Run Product Owner-led agent team' },
  { name: '/mcp',              desc: 'List loaded MCP servers' },
  { name: '/mcp-add',          desc: 'Add an MCP server' },
  { name: '/mcp-add-playwright', desc: 'Add Playwright browser automation MCP' },
  { name: '/mcp-create',       desc: 'Create and register a local MCP server' },
  { name: '/mcp-remove',       desc: 'Remove an MCP server' },
  { name: '/mcp-reload',       desc: 'Reload MCP servers from settings' },
  { name: '/mcp-security',     desc: 'Show MCP trust posture' },
  { name: '/workspace',        desc: 'Show/create AICO workspace' },
  { name: '/workspace-set',    desc: 'Configure workspace path' },
  { name: '/capabilities',     desc: 'Show tools, commands, and MCP powers' },
  { name: '/transcript',       desc: 'Export transcript to workspace' },
  { name: '/debug',            desc: 'Show/export runtime debug details' },
  { name: '/github-action',    desc: 'Create GitHub workflow template' },
  { name: '/ide-bridge',       desc: 'Create VS Code task bridge' },
  { name: '/scaffold',         desc: 'Generate full-stack project from requirements' },
  { name: '/security-audit',   desc: 'Run defensive security analysis' },
  { name: '/skills',           desc: 'List available skills' },
  { name: '/skill-install',    desc: 'Install a skill from a URL' },
  { name: '/bg-agents',        desc: 'Show background agents' },
  { name: '/bg-cancel',        desc: 'Cancel a background agent' },
  { name: '/worktrees',        desc: 'Show active git worktrees' },
  { name: '/cron',             desc: 'List scheduled cron jobs' },
  { name: '/cron-delete',      desc: 'Delete a cron job' },
  { name: '/cron-pause',       desc: 'Pause a cron job' },
  { name: '/cron-resume',      desc: 'Resume a paused cron job' },
  { name: '/exit',             desc: 'Exit aico' },
] as const;

// ── Cursor-aware full-featured text input ─────────────────────────
//
// Replaces ink-text-input entirely so we have full control over:
//   • shift+enter / meta+enter  → newline (not submit)
//   • backslash+enter           → newline (CC fallback)
//   • ctrl+j                    → newline
//   • bracketed paste (isPasted)→ insert full text including newlines
//   • ctrl+a/e, home/end        → cursor movement
//   • left/right arrows         → cursor movement
//
function useTextInput({
  value,
  onChange,
  onSubmit,
  isActive,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  isActive: boolean;
}) {
  const [cursor, setCursor] = useState(() => value.length);

  // Clamp cursor when value is replaced externally (e.g. cleared after submit)
  useEffect(() => {
    setCursor(c => Math.min(c, value.length));
  }, [value]);

  // Keep a fresh ref to the "insert newline at cursor" function.
  // The raw stdin handler calls this when it detects a Kitty shift+enter sequence.
  const insertNewlineRef = useRef<() => void>(() => {});
  insertNewlineRef.current = () => {
    if (!isActive) return;
    const before = value.slice(0, cursor);
    const after  = value.slice(cursor);
    onChange(before + '\n' + after);
    setCursor(c => c + 1);
  };

  // Register as the global handler on every render (always captures latest state).
  useEffect(() => {
    if (isActive) _shiftEnterGlobal.fn = () => insertNewlineRef.current();
    return () => void (_shiftEnterGlobal.fn = null);
  });

  useInput((input, key) => {
    if (!isActive) return;

    // ── Raw Kitty / modifyOtherKeys shift+enter sequences ────────
    // These arrive as unrecognised escape sequences passed verbatim as `input`.
    // \x1b[13;2u  = Kitty keyboard protocol shift+enter
    // \x1b[27;2;13~ = modifyOtherKeys level-2 shift+enter
    if (input === '\x1b[13;2u' || input === '\x1b[27;2;13~') {
      const before = value.slice(0, cursor);
      const after  = value.slice(cursor);
      onChange(before + '\n' + after);
      setCursor(cursor + 1);
      return;
    }

    // ── Paste (multi-char input) ───────────────────────────────────
    // Without bracketed paste, pasted text arrives as a multi-char chunk.
    // Detect: input.length > 1 without modifier keys = paste.
    // Also strip any \r (Windows CRLF), leftover escape sequences, and
    // bracketed paste markers (ESC[200~/ESC[201~) that some terminals
    // may still send.
    if (input.length > 1 && !key.ctrl && !key.meta && !key.escape) {
      const cleanInput = input
        .replace(/\x1b\[\?2004[hl]/g, '')  // strip bracketed paste markers
        .replace(/\x1b\[[0-9;]*[a-zA-Z~]/g, '') // strip any remaining escape seqs
        .replace(/\r/g, '');                // strip Windows \r
      if (cleanInput) {
        const before = value.slice(0, cursor);
        const after  = value.slice(cursor);
        onChange(before + cleanInput + after);
        setCursor(cursor + cleanInput.length);
      }
      return;
    }

    // ── Enter family ─────────────────────────────────────────────
    if (key.return) {
      // shift+enter or meta+enter (ESC+\r) → newline
      if (key.meta || key.shift) {
        const before = value.slice(0, cursor);
        const after  = value.slice(cursor);
        onChange(before + '\n' + after);
        setCursor(cursor + 1);
        return;
      }
      // backslash+enter → remove trailing backslash, insert newline  (CC fallback)
      if (cursor > 0 && value[cursor - 1] === '\\') {
        const before = value.slice(0, cursor - 1);
        const after  = value.slice(cursor);
        onChange(before + '\n' + after);
        // cursor stays at same position (backslash removed, newline inserted)
        return;
      }
      // plain enter → submit
      onSubmit(value);
      setCursor(0);
      return;
    }

    // ctrl+j → newline (universal fallback)
    if (key.ctrl && input === 'j') {
      const before = value.slice(0, cursor);
      const after  = value.slice(cursor);
      onChange(before + '\n' + after);
      setCursor(cursor + 1);
      return;
    }

    // ── Skip modifier combos (except editing shortcuts) ──────────
    if (key.escape || key.tab) return;
    if (key.ctrl) {
      // Allow: ctrl+a/e (cursor), ctrl+u/k/w (line editing) — handled below
      if ('aekuw'.includes(input)) { /* fall through to handlers below */ }
      // ctrl+v: swallow the control char — actual paste content arrives
      // separately via bracketed paste or as regular input events
      else return;
    }

    // ── Cursor movement ─────────────────────────────────────────
    if (key.leftArrow)  { setCursor(c => Math.max(0, c - 1));              return; }
    if (key.rightArrow) { setCursor(c => Math.min(value.length, c + 1));   return; }
    if (key.home || (key.ctrl && input === 'a')) { setCursor(0);            return; }
    if (key.end  || (key.ctrl && input === 'e')) { setCursor(value.length); return; }
    // ctrl+u: delete from start to cursor
    if (key.ctrl && input === 'u') {
      onChange(value.slice(cursor)); setCursor(0); return;
    }
    // ctrl+k: delete from cursor to end
    if (key.ctrl && input === 'k') {
      onChange(value.slice(0, cursor)); return;
    }
    // ctrl+w: delete word before cursor
    if (key.ctrl && input === 'w') {
      const before = value.slice(0, cursor);
      const trimmed = before.replace(/\S+\s*$/, '');
      onChange(trimmed + value.slice(cursor));
      setCursor(trimmed.length);
      return;
    }

    // ── Backspace / delete ───────────────────────────────────────
    if (key.backspace || key.delete) {
      if (cursor > 0) {
        onChange(value.slice(0, cursor - 1) + value.slice(cursor));
        setCursor(cursor - 1);
      }
      return;
    }

    // ── Regular printable character ──────────────────────────────
    if (input && !key.ctrl && !key.meta && input.length >= 1) {
      const before = value.slice(0, cursor);
      const after  = value.slice(cursor);
      onChange(before + input + after);
      setCursor(cursor + input.length);
    }
  }, { isActive });

  return { cursor };
}

// Render the text with a blinking block cursor at the right position
function InputDisplay({
  value,
  cursor,
  placeholder,
}: {
  value: string;
  cursor: number;
  placeholder: string;
}) {
  // Blink the cursor every 530ms (standard terminal blink rate)
  const [cursorVisible, setCursorVisible] = useState(true);
  useEffect(() => {
    const timer = setInterval(() => setCursorVisible(v => !v), 530);
    return () => clearInterval(timer);
  }, []);
  // Reset cursor visibility on any input change (cursor always visible when typing)
  useEffect(() => { setCursorVisible(true); }, [value, cursor]);

  if (!value) {
    return (
      <Box>
        <Text color="green" bold>{'❯ '}</Text>
        {cursorVisible
          ? <Text backgroundColor="white" color="black">{' '}</Text>
          : <Text>{' '}</Text>}
        <Text color="gray" dimColor>{placeholder}</Text>
      </Box>
    );
  }

  const lines = value.split('\n');
  let charCount = 0;

  return (
    <Box flexDirection="column">
      {lines.map((line, li) => {
        const lineStart = charCount;
        charCount += line.length + (li < lines.length - 1 ? 1 : 0); // +1 for \n
        const cursorInThisLine = cursor >= lineStart && cursor <= lineStart + line.length;
        const localCursor = cursor - lineStart;

        if (cursorInThisLine) {
          const before = line.slice(0, localCursor);
          const atCursor = line[localCursor] ?? ' ';
          const after = line.slice(localCursor + 1);
          return (
            <Box key={li}>
              <Text color="green" bold>{li === 0 ? '❯ ' : '  '}</Text>
              <Text>{before}</Text>
              {cursorVisible
                ? <Text backgroundColor="white" color="black">{atCursor}</Text>
                : <Text>{atCursor}</Text>}
              <Text>{after}</Text>
            </Box>
          );
        }
        return (
          <Box key={li}>
            <Text color="green" bold>{li === 0 ? '❯ ' : '  '}</Text>
            <Text>{line}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

// ── Slash command autocomplete ─────────────────────────────────────
function CommandSuggestions({
  value,
  selected,
}: {
  value: string;
  selected: number;
}) {
  const lower = value.toLowerCase();
  const matches = SLASH_COMMANDS.filter(c =>
    c.name.startsWith(lower) || c.name.replace('/', '/').startsWith(lower),
  );
  if (matches.length === 0) return null;

  return (
    <Box flexDirection="column" marginBottom={0}>
      {matches.map((cmd, i) => (
        <Box key={cmd.name}>
          <Text
            color={i === selected ? 'black' : 'white'}
            backgroundColor={i === selected ? 'cyan' : undefined}
            bold={i === selected}
          >
            {'  '}{cmd.name.padEnd(18)}{' '}
          </Text>
          <Text dimColor={i !== selected}>{cmd.desc}</Text>
        </Box>
      ))}
    </Box>
  );
}

// ── Multi-line Input (thin wrapper around useTextInput + InputDisplay) ─
function MultiLineInput({
  value,
  onChange,
  onSubmit,
  placeholder,
  isActive = true,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  placeholder: string;
  isActive?: boolean;
}) {
  const [acSelected, setAcSelected] = useState(0);

  // Filter autocomplete list
  const showAC = value.startsWith('/') && !value.includes(' ') && !value.includes('\n');
  const acMatches = showAC
    ? SLASH_COMMANDS.filter(c => c.name.startsWith(value.toLowerCase()))
    : [];
  const clampedSelected = Math.min(acSelected, Math.max(0, acMatches.length - 1));

  // Reset selection when list changes
  useEffect(() => { setAcSelected(0); }, [value]);

  // Handle autocomplete navigation + Tab completion
  useInput((input, key) => {
    if (!isActive) return;
    if (!showAC || acMatches.length === 0) return;

    if (key.upArrow) {
      setAcSelected(s => Math.max(0, s - 1));
      return;
    }
    if (key.downArrow) {
      setAcSelected(s => Math.min(acMatches.length - 1, s + 1));
      return;
    }
    if (key.tab) {
      const cmd = acMatches[clampedSelected];
      if (cmd) {
        // Complete with a trailing space if the command takes arguments
        const trail = cmd.name.endsWith(' ') || cmd.desc.includes('[') || cmd.desc.includes('<')
          ? ' ' : '';
        onChange(cmd.name + trail);
      }
    }
    // Esc: clear input back to empty (dismiss autocomplete)
    if (key.escape) {
      onChange('');
      setAcSelected(0);
    }
  }, { isActive });

  const { cursor } = useTextInput({ value, onChange, onSubmit, isActive });
  const isML = value.includes('\n');

  return (
    <Box flexDirection="column">
      {showAC && acMatches.length > 0 && (
        <CommandSuggestions value={value} selected={clampedSelected} />
      )}
      <InputDisplay value={value} cursor={cursor} placeholder={placeholder} />
      {isML && (
        <Text dimColor>{'  shift+↵ or ctrl+j=newline  ↵=send'}</Text>
      )}
    </Box>
  );
}

// ── Inline markdown renderer ───────────────────────────────────────
// Supports: **bold**, *italic*, `code`, [links](url), ~~strikethrough~~
function InlineMd({ text }: { text: string }) {
  // Split on all inline patterns, preserving the delimiters
  const parts = text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*|~~[^~\n]+~~|\[[^\]\n]+\]\([^)\n]+\))/g);
  return (
    <>
      {parts.map((part, i) => {
        if (!part) return null;
        // **bold**
        if (part.startsWith('**') && part.endsWith('**'))
          return <Text key={i} bold>{part.slice(2, -2)}</Text>;
        // `code`
        if (part.startsWith('`') && part.endsWith('`'))
          return <Text key={i} color="green">{part.slice(1, -1)}</Text>;
        // *italic*
        if (part.startsWith('*') && part.endsWith('*') && part.length > 2)
          return <Text key={i} italic>{part.slice(1, -1)}</Text>;
        // ~~strikethrough~~
        if (part.startsWith('~~') && part.endsWith('~~'))
          return <Text key={i} strikethrough>{part.slice(2, -2)}</Text>;
        // [link text](url) — render as underlined text in blue
        const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (linkMatch)
          return <Text key={i} color="cyan" underline>{linkMatch[1]}</Text>;
        return <Text key={i}>{part}</Text>;
      })}
    </>
  );
}

function MarkdownLine({ line, inCodeBlock }: { line: string; inCodeBlock: boolean }) {
  // Code block content (green monospace)
  if (inCodeBlock || line.startsWith('    ')) return <Text color="green">{line}</Text>;
  // Code fence delimiters (dim)
  if (line.startsWith('```')) return <Text color="gray" dimColor>{line}</Text>;
  // Headings H1-H6
  if (line.startsWith('###### ')) return <Text dimColor bold>{line.slice(7)}</Text>;
  if (line.startsWith('##### ')) return <Text dimColor bold>{line.slice(6)}</Text>;
  if (line.startsWith('#### '))  return <Text dimColor bold>{line.slice(5)}</Text>;
  if (line.startsWith('### '))   return <Text bold>{line.slice(4)}</Text>;
  if (line.startsWith('## '))    return <Text bold>{line.slice(3)}</Text>;
  if (line.startsWith('# '))     return <Text bold color={CORAL}>{line.slice(2)}</Text>;
  // Blockquote
  if (/^> /.test(line)) return (
    <Box><Text color="gray">{'│ '}</Text><InlineMd text={line.slice(2)} /></Box>
  );
  // Nested bullet lists (2-space indent = nested)
  if (/^  [-*] /.test(line)) return (
    <Box><Text color="cyan">{'    ◦ '}</Text><InlineMd text={line.slice(4)} /></Box>
  );
  // Top-level bullet lists
  if (/^[-*] /.test(line)) return (
    <Box><Text color="cyan">{'  • '}</Text><InlineMd text={line.slice(2)} /></Box>
  );
  // Numbered lists (preserve the number)
  if (/^\d+\. /.test(line)) return (
    <Box><Text color="cyan">{'  '}</Text><InlineMd text={line} /></Box>
  );
  // Horizontal rule
  if (/^---+$/.test(line.trim())) return <Text dimColor>{'─'.repeat(40)}</Text>;
  // Table rows (basic — render as-is with dim color)
  if (line.startsWith('|') && line.endsWith('|')) return <Text dimColor>{line}</Text>;
  // Regular text
  return <Box flexWrap="wrap"><InlineMd text={line} /></Box>;
}

function MarkdownText({ content }: { content: string }) {
  const lines = content.split('\n');
  let inCode = false;
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        if (line.startsWith('```')) inCode = !inCode;
        return (
          <MarkdownLine
            key={i}
            line={line}
            inCodeBlock={inCode && !line.startsWith('```')}
          />
        );
      })}
    </Box>
  );
}

// ── Welcome panel (rendered once at startup via Static) ───────────
// Matches the two-column bordered layout of Claude Code CLI.
const AICO_LOGO = [
  '   ╭──────╮   ',
  '   │ ◉  ◉ │   ',
  '   │  ──  │   ',
  '   │ ████ │   ',
  '   ╰──────╯   ',
];

function WelcomeLine({ entry }: { entry: HistoryEntry }) {
  // Special rendering for the welcome block (type=system, content starts with '__welcome__')
  if (entry.type === 'system' && entry.content.startsWith('__welcome__')) {
    // Guarded parse: a truncated/corrupt welcome payload in history must not
    // crash the whole UI during render. Fall back to a minimal degraded card.
    let data: { model: string; cwd: string; sessionId: string; effort?: string; resumed?: boolean };
    try {
      data = JSON.parse(entry.content.slice('__welcome__'.length));
    } catch {
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={CORAL} paddingX={2} marginY={1}>
          <Text bold color={CORAL}>{'✻ aico'}</Text>
          <Text dimColor>{'(session resumed)'}</Text>
        </Box>
      );
    }
    const shortModel = data.model.replace('claude-', '').replace('-latest', '');
    const shortCwd   = data.cwd.replace(/\\/g, '/');
    const hasEffort  = data.effort && data.effort !== 'medium';
    const effortLabel = hasEffort ? ` · effort: ${data.effort}` : '';

    // Claude Code-style refined welcome: single coral-bordered card, clean layout
    return (
      <Box flexDirection="column" marginY={1}>
        <Box flexDirection="column" borderStyle="round" borderColor={CORAL} paddingX={2} paddingY={0}>
          <Text bold color={CORAL}>{'✻ aico'}</Text>
          <Text dimColor>{`Model: ${shortModel}${effortLabel}`}</Text>
          <Text dimColor>{`CWD: ${shortCwd}`}</Text>
          {data.resumed && <Text color="yellow" dimColor>{'(resumed session)'}</Text>}
          <Text dimColor>{'/help for commands · /status for environment · /doctor for diagnostics'}</Text>
        </Box>
      </Box>
    );
  }

  // Regular history line
  return <HistoryLine entry={entry} />;
}

// ── Bottom Status Bar ──────────────────────────────────────────────
// Single line — matches Claude Code CLI format. Shows context-window %,
// per-turn cost, model, CWD, git branch, effort, plan mode, and MCP health.
function StatusBar({
  tokens,
  cost,
  model,
  cwd,
  gitBranch,
  effort,
  planMode,
  autoApprove,
  mcpServers: mcpInfos,
  settings,
}: {
  tokens: number;
  cost: number;
  model: string;
  cwd: string;
  gitBranch: string | null;
  effort?: string;
  planMode?: boolean;
  autoApprove?: boolean;
  mcpServers?: McpServerInfo[];
  settings?: AicoSettings;
}) {
  const shortCwd = cwd.split(/[\\/]/).pop() ?? cwd;
  const shortModel = model.replace('claude-', '').replace('-latest', '').replace('gpt-', 'gpt/');
  const branchStr = gitBranch ? ` · ${gitBranch}` : '';
  const effortStr = effort && effort !== 'medium' ? ` · effort:${effort}` : '';
  const modeStr = planMode ? ' · PLAN' : autoApprove ? ' · AUTO' : '';
  const newlineHint = 'shift+↵ newline';

  // Dynamic context window — reads from settings.contextWindows (permanent
  // overrides from runtime detection) or the corrected built-in table.
  // DeepSeek V4 → 1M, Gemini 2.5 → 1M, Claude → 200K, etc.
  const CONTEXT_WINDOW = getContextWindow(model, settings);
  const ctxPct = Math.min(100, Math.round((tokens / CONTEXT_WINDOW) * 100));
  const ctxColor = ctxPct > 90 ? 'red' : ctxPct > 70 ? 'yellow' : undefined;

  const tokenStr = tokens > 0
    ? `  · ${tokens.toLocaleString()} tokens${cost > 0 ? ` (~$${cost.toFixed(4)})` : ''}` +
      (ctxPct > 5 ? ` · ctx: ` : '')
    : '';

  // MCP health indicator
  const mcpStr = mcpInfos && mcpInfos.length > 0
    ? ' · mcp: ' + mcpInfos.map((s) => `${s.name}(${s.health === 'healthy' ? '✓' : s.health === 'degraded' ? '~' : '✗'})`).join(' ')
    : '';

  return (
    <Box marginTop={1}>
      <Text dimColor>
        {shortModel} · {shortCwd}{branchStr}{effortStr}{modeStr}{mcpStr}{tokenStr}
      </Text>
      {ctxPct > 5 && ctxColor && (
        <Text color={ctxColor} bold>{`${ctxPct}%`}</Text>
      )}
      {ctxPct > 5 && !ctxColor && (
        <Text dimColor>{`${ctxPct}%`}</Text>
      )}
      <Text dimColor>{`  ${newlineHint}`}</Text>
    </Box>
  );
}

// ── Main App ───────────────────────────────────────────────────────
export function AicoApp(props: InkAppProps) {
  const [staticItems, setStaticItems]     = useState<HistoryEntry[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [input,   setInput]               = useState('');
  const [isThinking, setIsThinking]       = useState(false);
  const [spinnerLabel, setSpinnerLabel]   = useState('Thinking…');
  const [currentModel, setCurrentModel]   = useState(props.model);
  const [planMode, setPlanMode]             = useState(false);
  // Claude Code-style mode cycling: Normal → Plan → Auto-Accept (Shift+Tab)
  const [autoAcceptMode, setAutoAcceptMode] = useState(false);
  const [pendingPerm, setPendingPerm]     = useState<PermissionRequest | null>(null);
  const [pendingAsk,  setPendingAsk]      = useState<AskUserRequest | null>(null);
  const [todos, setTodos]                 = useState<Todo[]>([]);
  const [totalTokens, setTotalTokens]     = useState(0);
  const [totalCost, setTotalCost]         = useState(0);
  const [subAgents, setSubAgents]         = useState<SubAgentRec[]>([]);
  const [gitBranch, setGitBranch]         = useState<string | null>(null);
  // ── Concurrent operations panel navigation (Claude Code bottom panel) ──
  // When focused, arrow keys scroll/select operations instead of editing input.
  // → or Enter opens detail view; ← or Esc returns focus to input.
  const [opsFocus, setOpsFocus]           = useState(false);
  const [opsSelected, setOpsSelected]     = useState(0);
  const [opsDetail, setOpsDetail]         = useState(false);
  // Pending attachments shown as chips above the input
  const [attachments, setAttachments]     = useState<ResolvedAttachment[]>([]);
  // New feature panels
  const [bgAgents, setBgAgents]           = useState<BackgroundAgentRecord[]>([]);
  const [worktrees, setWorktrees]         = useState<WorktreeRecord[]>([]);
  const [cronJobs, setCronJobs]           = useState<CronJob[]>([]);
  const [mcpServers, setMcpServers]       = useState<McpServerInfo[]>([]);
  const { exit } = useApp();

  const histRef      = useRef<Array<{ role: string; content: string }>>(props.resumedHistory ?? []);
  const tokenTracker = useRef(createTokenTracker());
  const trustRef     = useRef<'all' | 'none' | Set<string>>(new Set());
  const liveOpsRef   = useRef<LiveOp[]>([]);
  // AbortController for the current agent run — Escape cancels the active task
  const abortRef      = useRef<AbortController | null>(null);
  // Messages queued during processing — run after the current task finishes
  const queuedMessagesRef = useRef<string[]>([]);
  // Bump this state to force a re-render when liveOpsRef changes (the ref alone
  // doesn't trigger renders). This makes the live tool list animate correctly.
  const [, setLiveOpsTick] = useState(0);
  const opIdRef      = useRef(0);
  const effortHint   = useRef(buildEffortHint(props.effort));

  /** Update liveOpsRef using an updater fn and trigger a re-render */
  const setLiveOpsSync = useCallback((updater: (ops: LiveOp[]) => LiveOp[]) => {
    liveOpsRef.current = updater(liveOpsRef.current);
    setLiveOpsTick(t => t + 1);
  }, []);

  // Fetch git branch on mount
  useEffect(() => {
    getGitBranch(props.cwd).then(b => setGitBranch(b)).catch(() => {});
  }, [props.cwd]);

  // Subscribe to sub-agent registry updates
  useEffect(() => {
    let mounted = true;
    import('../tools/task.js').then(({ subscribeToAgents }) => {
      const unsub = subscribeToAgents((recs) => {
        if (mounted) setSubAgents(recs as SubAgentRec[]);
      });
      return unsub;
    }).catch(() => {});
    return () => { mounted = false; };
  }, []);

  // Clamp ops panel selection when agents list shrinks (auto-clear)
  useEffect(() => {
    if (subAgents.length === 0) {
      setOpsFocus(false);
      setOpsDetail(false);
    } else if (opsSelected >= subAgents.length) {
      setOpsSelected(Math.max(0, subAgents.length - 1));
    }
  }, [subAgents.length, opsSelected]);

  // Subscribe to background agents
  useEffect(() => {
    let mounted = true;
    import('../background/index.js').then(({ subscribeToBackgroundAgents }) => {
      const unsub = subscribeToBackgroundAgents((recs) => {
        if (mounted) setBgAgents(recs);
      });
      return unsub;
    }).catch(() => {});
    return () => { mounted = false; };
  }, []);

  // Subscribe to worktrees
  useEffect(() => {
    let mounted = true;
    import('../worktree/index.js').then(({ worktreeManager }) => {
      const unsub = worktreeManager.subscribe((recs) => {
        if (mounted) setWorktrees(recs);
      });
      return unsub;
    }).catch(() => {});
    return () => { mounted = false; };
  }, []);

  // Subscribe to cron jobs
  useEffect(() => {
    let mounted = true;
    import('../cron/scheduler.js').then(({ cronScheduler }) => {
      const unsub = cronScheduler.subscribe((jobs) => {
        if (mounted) setCronJobs(jobs);
      });
      return unsub;
    }).catch(() => {});
    return () => { mounted = false; };
  }, []);

  // Subscribe to MCP server health
  useEffect(() => {
    let mounted = true;
    import('../mcp/registry.js').then(({ mcpRegistry }) => {
      const unsub = mcpRegistry.subscribe((servers) => {
        if (mounted) setMcpServers(servers);
      });
      return unsub;
    }).catch(() => {});
    return () => { mounted = false; };
  }, []);

  // Enable Kitty keyboard protocol so shift+enter sends \x1b[13;2u (distinct from enter)
  // and modifyOtherKeys level-2 so xterm-compatible terminals send \x1b[27;2;13~.
  //
  // NOTE: We intentionally do NOT enable bracketed paste (\x1b[?2004h).
  // Ink 6.x does not parse ESC[200~/ESC[201~ markers — enabling it causes paste
  // content to arrive with embedded escape sequences that break input handling.
  // Without bracketed paste, pasted text arrives as regular input (single chars or
  // multi-char chunks) which our useTextInput handles correctly.
  useEffect(() => {
    // Explicitly DISABLE bracketed paste in case the terminal has it on by default
    process.stdout.write('\x1b[?2004l'); // bracketed paste OFF
    process.stdout.write('\x1b[>1u');    // Kitty keyboard protocol ON
    process.stdout.write('\x1b[>4;2m'); // modifyOtherKeys level 2 ON

    // Raw stdin fallback: some terminals send the Kitty/modifyOtherKeys sequence as a
    // chunk that readline doesn't parse as key.return, so we intercept it here and fire
    // the global shift+enter handler directly.
    const handleRaw = (data: Buffer) => {
      const s = data.toString();
      if (s === '\x1b[13;2u' || s === '\x1b[27;2;13~') {
        _shiftEnterGlobal.fn?.();
      }
    };
    process.stdin.on('data', handleRaw);

    return () => {
      process.stdout.write('\x1b[<u');     // Kitty keyboard protocol OFF
      process.stdout.write('\x1b[>4;0m'); // modifyOtherKeys OFF
      process.stdin.removeListener('data', handleRaw);
    };
  }, []);

  // ctrl+p → try to grab an image from the system clipboard and attach it
  useInput((input, key) => {
    // ── Concurrent operations panel navigation (Claude Code bottom panel) ──
    // When opsFocus is active, intercept arrow keys / Enter / Esc for navigation.
    // This lets the user scroll through running operations, select one to see
    // details, and return to the terminal input.
    if (opsFocus && subAgents.length > 0) {
      // Count visible agents (studio + other, same grouping as AgentsPanel)
      const visibleCount = subAgents.length;
      if (opsDetail) {
        // In detail view: ← or Esc returns to list
        if (key.leftArrow || key.escape) {
          setOpsDetail(false);
          return;
        }
        if (key.upArrow) {
          setOpsSelected(s => (s - 1 + visibleCount) % visibleCount);
          return;
        }
        if (key.downArrow) {
          setOpsSelected(s => (s + 1) % visibleCount);
          return;
        }
        // Any other key — keep in detail view
        return;
      }
      // In list view:
      if (key.upArrow) {
        setOpsSelected(s => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        setOpsSelected(s => Math.min(visibleCount - 1, s + 1));
        return;
      }
      if (key.rightArrow || key.return) {
        setOpsDetail(true);
        return;
      }
      if (key.leftArrow || key.escape) {
        // Exit ops panel focus — return to input
        setOpsFocus(false);
        return;
      }
      // Don't pass other keys to input while ops-focused
      return;
    }

    // During processing: Escape or Ctrl+C cancels the current task (not exit)
    if (isThinking) {
      if (key.escape || (key.ctrl && input === 'c')) {
        if (abortRef.current) {
          abortRef.current.abort();
          pushStatic({ type: 'system', content: '  ✕ Task cancelled by user.' });
        }
      }
      return; // Don't process other keys while thinking (except cancel above)
    }

    // ── Enter ops panel: Down arrow when input is empty + agents exist ──
    // Claude Code lets you press ↓ to scroll into the concurrent operations list.
    if (key.downArrow && input.trim() === '' && !input && subAgents.length > 0 && !opsFocus) {
      setOpsFocus(true);
      setOpsDetail(false);
      return;
    }
    // Shift+Tab cycles modes: Normal → Plan → Auto-Accept → Normal
    // (Claude Code behavior — the input border color changes to signal the mode)
    if (key.tab && key.shift) {
      if (!planMode && !autoAcceptMode) {
        setPlanMode(true);
        pushStatic({ type: 'system', content: '  ◐ Plan mode: read-only — no edits or writes until you exit plan mode.' });
      } else if (planMode) {
        setPlanMode(false);
        setAutoAcceptMode(true);
        pushStatic({ type: 'system', content: '  ◑ Auto-accept mode: tool calls approved without prompts.' });
      } else {
        setAutoAcceptMode(false);
        pushStatic({ type: 'system', content: '  ○ Normal mode: permissions enforced per rules.' });
      }
      return;
    }
    if (key.ctrl && input === 'p') {
      readClipboardImage().then(att => {
        if (att) {
          setAttachments(a => [...a, att]);
          pushStatic({ type: 'system', content: `📋 Clipboard image attached` });
        } else {
          pushStatic({ type: 'system', content: '  No image found in clipboard.' });
        }
      }).catch(() => {});
      return;
    }
    // ctrl+x → remove last pending attachment
    if (key.ctrl && input === 'x') {
      setAttachments(a => {
        if (a.length === 0) return a;
        const removed = a[a.length - 1];
        pushStatic({ type: 'system', content: `  ✕ Removed attachment: ${removed.label}` });
        return a.slice(0, -1);
      });
    }
  }, { isActive: true });

  // Show welcome panel once at startup via static history
  useEffect(() => {
    setStaticItems([{
      type: 'system',
      content: `__welcome__${JSON.stringify({
        model: props.model,
        cwd: props.cwd,
        sessionId: props.sessionId,
        effort: props.effort,
        resumed: (props.resumedHistory?.length ?? 0) > 0,
      })}`,
    }]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load persisted trust from .aico/trust.json on mount
  useEffect(() => {
    loadTrust(props.cwd).then(trust => {
      trustRef.current = trust;
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Push a committed entry to static history */
  const pushStatic = useCallback((entry: HistoryEntry) => {
    setStaticItems(s => [...s.slice(-200), entry]);
  }, []);

  /** Commit all current liveOps to static history, then clear the live panel */
  const flushLiveOps = useCallback(() => {
    const ops = liveOpsRef.current;
    if (ops.length === 0) return;
    setStaticItems(s => {
      const newEntries: HistoryEntry[] = ops.map(op => ({
        type: 'tool_done' as const,
        content: op.label,
        detail: op.detail,
        toolName: op.name,
      }));
      return [...s.slice(-200), ...newEntries];
    });
    liveOpsRef.current = [];
  }, []);

  // ── Permission callback ──────────────────────────────────────────
  const requestPermission = useCallback(
    (toolName: string, detail: string, fileDiff?: { path: string; added?: string[]; removed?: string[]; preview?: string }): Promise<boolean> => {
      return new Promise(resolve => {
        const trust = trustRef.current;
        if (trust === 'all')  { resolve(true);  return; }
        if (trust === 'none') { resolve(false); return; }
        if (trust instanceof Set && trust.has(toolName)) { resolve(true); return; }
        setPendingPerm({ toolName, detail, ...(fileDiff ? { fileDiff } : {}), resolve });
      });
    },
    [],
  );

  const handlePerm = useCallback((allowed: boolean, all?: boolean) => {
    if (!pendingPerm) return;
    if (all && allowed) {
      trustRef.current = 'all';
      pushStatic({ type: 'system', content: '✓ All tools trusted for this session' });
      saveTrust(props.cwd, 'all').catch(() => {});
    }
    if (all && !allowed) {
      trustRef.current = 'none';
      pushStatic({ type: 'system', content: '✗ All tools denied for this session' });
    }
    if (allowed && !all && trustRef.current instanceof Set) {
      trustRef.current.add(pendingPerm.toolName);
      saveTrust(props.cwd, trustRef.current).catch(() => {});
    }
    pendingPerm.resolve(allowed);
    setPendingPerm(null);
  }, [pendingPerm, pushStatic, props.cwd]);

  // ── AskUser callback ─────────────────────────────────────────────
  const requestAsk = useCallback((question: string): Promise<string> => {
    return new Promise(resolve => setPendingAsk({ question, resolve }));
  }, []);

  const handleAsk = useCallback((answer: string) => {
    if (!pendingAsk) return;
    pushStatic({ type: 'system', content: `  ⎿  ${answer}` });
    pendingAsk.resolve(answer);
    setPendingAsk(null);
  }, [pendingAsk, pushStatic]);

  // ── Submit handler ───────────────────────────────────────────────
  const handleSubmit = useCallback(async (value: string, _silent = false) => {
    // The agent is already working. Steer it rather than queueing behind the
    // whole run: the message is delivered at the next step boundary, so a
    // correction reaches the model before it takes another action instead of
    // sitting idle while it goes further down the wrong path. The turn is
    // extended rather than replaced, so tool results so far are kept.
    //
    // Falls back to the old queue-until-finished behaviour when no durable
    // inbox is available (legacy sessions), so nothing is ever silently lost.
    if (isThinking && !_silent) {
      const queued = value.trim();
      if (queued) {
        pushStatic({ type: 'user', content: queued });
        if (props.inbox) {
          props.inbox.steer(queued);
          pushStatic({ type: 'system', content: '  (steering — applies at the next step)' });
        } else {
          queuedMessagesRef.current.push(queued);
          pushStatic({ type: 'system', content: '  (queued — will run after current task)' });
        }
        setInput('');
      }
      return;
    }

    // Strip terminal escape sequences from pasted input
    const raw = value
      .replace(/\x1b\[[0-9;]*~?/g, '')
      .replace(/\[2[0-9][0-9]~/g, '')
      .trim();

    // Parse @attach tokens out of the prompt
    const { prompt: trimmed, paths: attachPaths } = parseAttachTokens(raw);

    if (!trimmed && attachPaths.length === 0 && attachments.length === 0) return;
    setInput('');

    // Resolve @attach paths to SDK attachments
    const fileAtts: ResolvedAttachment[] = [];
    for (const p of attachPaths) {
      const att = await resolveFileAttachment(p, props.cwd);
      if (att) fileAtts.push(att);
      else pushStatic({ type: 'system', content: `  ✗ File not found: ${p}` });
    }

    // Merge clipboard/pending attachments + newly resolved file attachments
    const allAtts = [...attachments, ...fileAtts];
    setAttachments([]);  // clear pending chips

    if (trimmed === 'exit' || trimmed === 'quit') {
      exit();
      return;
    }

    if (trimmed.startsWith('/')) {
      const usage = tokenTracker.current.getUsage();
      const res = await handleSlashCommand(trimmed, {
        conversationHistory: histRef.current,
        currentModel,
        sessionId: props.sessionId,
        tokenCount: {
          input: usage.inputTokens,
          output: usage.outputTokens,
          cost: tokenTracker.current.estimateCost(currentModel),
        },
        setModel: m => setCurrentModel(m),
        clearHistory: () => {
          // mutate in-place so ctx.conversationHistory reference stays valid
          histRef.current.length = 0;
          pushStatic({ type: 'system', content: '  ⎿  History cleared' });
        },
        replaceHistory: (msgs: Array<{ role: string; content: string }>) => {
          histRef.current.length = 0;
          for (const m of msgs) histRef.current.push(m);
        },
        planMode,
        setPlanMode,
        settings: props.settings,
        ...(props.session ? { session: props.session } : {}),
      });
      if (res.handled) {
        if (res.output) pushStatic({ type: 'system', content: res.output });
        if (res.newTokenCount !== undefined) setTotalTokens(res.newTokenCount);
        if (res.exit) { exit(); }
        // Some commands (e.g. /scaffold, /security-audit) send a prompt to the agent
        if (res.sendAsPrompt) {
          setInput('');
          handleSubmit(res.sendAsPrompt, true); // silent=true — don't show orchestration prompt in UI
        }
        // Deterministic studio pipeline execution (instead of sendAsPrompt).
        if (res.runStudioPipeline) {
          setInput('');
          setIsThinking(true);
          setSpinnerLabel('Studio pipeline…');
          // Abort controller so Ctrl+C cancels the pipeline cleanly.
          const studioAbort = new AbortController();
          const onSigInt = () => studioAbort.abort();
          process.once('SIGINT', onSigInt);
          try {
            const state = await readState(res.runStudioPipeline.projectDir);
            if (!state) {
              pushStatic({ type: 'error', content: 'Studio state not found. Run /studio <requirements> to start a new build.' });
            } else {
              const runtime = createStudioRuntime({
                model: currentModel,
                autoApprove: props.autoApprove,
                verbose: props.verbose,
                settings: props.settings,
                abortSignal: studioAbort.signal,
              });
              const pipelineResult = await runPipeline(state, {
                runTask: runtime.runTask,
                askUser: runtime.askUser,
                abortSignal: studioAbort.signal,
              });
              const summary = pipelineResult.summary || 'Studio pipeline finished.';
              const statusLine = pipelineResult.success
                ? `✅ ${pipelineResult.completedPhases}/${pipelineResult.totalPhases} phases in ${Math.round(pipelineResult.durationMs / 1000)}s.`
                : `⚠️ Incomplete: ${pipelineResult.completedPhases}/${pipelineResult.totalPhases} phases.`;
              pushStatic({ type: 'assistant', content: `${summary}\n${statusLine}` });
              histRef.current.push({ role: 'user', content: `/studio ${state.requirements}` });
              histRef.current.push({ role: 'assistant', content: summary });
              compactActiveContext(histRef.current, props.settings, currentModel, props.session);
            }
          } catch (err) {
            pushStatic({ type: 'error', content: err instanceof Error ? err.message : String(err) });
          } finally {
            process.removeListener('SIGINT', onSigInt);
            setIsThinking(false);
            setSpinnerLabel('Thinking…');
          }
        }
      }
      return;
    }

    // Show user message in history (unless triggered silently by sendAsPrompt)
    if (!_silent) {
      pushStatic({ type: 'user', content: trimmed || '(attachment)' });
      for (const att of allAtts) {
        pushStatic({ type: 'system', content: `  ⎙  ${att.label}` });
      }
    }
    setIsThinking(true);
    setSpinnerLabel('Thinking…');
    setStreamingText('');
    liveOpsRef.current = [];

    // Create an AbortController so the user can cancel with Escape during processing.
    // This mirrors the studio pipeline's SIGINT→abort pattern.
    const runAbort = new AbortController();
    abortRef.current = runAbort;

    try {
      const result = await runAgent({
        task: trimmed,
        model: currentModel,
        filePath: props.filePath,
        showPlan: props.showPlan,
        autoApprove: props.autoApprove || autoAcceptMode,
        verbose: props.verbose,
        conversationHistory: histRef.current,
        sessionId: props.sessionId,
        tokenTracker: tokenTracker.current,
        settings: props.settings,
        silent: true,
        planMode,
        effort: props.effort,
        attachments: allAtts.length > 0 ? allAtts.map(a => a.sdkAttachment) : undefined,
        abortSignal: runAbort.signal,
        ...(props.session ? { session: props.session } : {}),
        ...(props.inbox ? { inbox: props.inbox } : {}),

        onToolCall: (name: string, args: Record<string, unknown>) => {
          // Clear streaming text when a tool starts — model's intro text is now "done"
          setStreamingText('');
          const arg = String(
            args.command ?? args.file_path ?? args.pattern ?? args.url ?? args.question ?? '',
          ).slice(0, 80);
          const label = arg ? `${name}(${arg})` : name;
          const id = ++opIdRef.current;
          setSpinnerLabel(label);
          setLiveOpsSync(ops => [...ops, { id, name, label, status: 'running' }]);
        },

        onToolDone: (name: string, res: unknown) => {
          setSpinnerLabel('Thinking…');
          let preview = '';
          if (typeof res === 'string') preview = res.split('\n')[0].slice(0, 100);
          else if (res && typeof res === 'object') {
            const r = res as Record<string, unknown>;
            if (typeof r.content === 'string') preview = r.content.split('\n')[0].slice(0, 100);
            else if (typeof r.stdout === 'string') preview = r.stdout.split('\n')[0].slice(0, 100);
            else if (r.error) preview = `Error: ${r.error}`;
          }
          // Move completed op immediately from live panel to static history
          setLiveOpsSync(ops => {
            const idx = [...ops].reverse().findIndex(
              o => o.name === name && o.status === 'running',
            );
            if (idx === -1) return ops;
            const realIdx = ops.length - 1 - idx;
            const op = ops[realIdx];
            setStaticItems(s => [
              ...s.slice(-200),
              {
                type: 'tool_done' as const,
                content: op.label,
                detail: preview || undefined,
                toolName: op.name,
              },
            ]);
            return ops.filter((_, i) => i !== realIdx);
          });
          // Update todo list when TodoWrite runs
          if (name === 'TodoWrite' && res && typeof res === 'object') {
            const r = res as { todos?: Todo[] };
            if (Array.isArray(r.todos)) setTodos(r.todos);
          }
        },

        onChunk: (text: string) => {
          // text is the full accumulated response so far — show it live
          setStreamingText(text);
          setSpinnerLabel('Responding…');
          // Live-update the token estimate so the context % stays current
          // during streaming (rough: ~4 chars per token)
          setTotalTokens(t => Math.max(t, Math.ceil(text.length / 4)));
        },

        onSubagentStart: (rec) => {
          const id = ++opIdRef.current;
          setLiveOpsSync(ops => [
            ...ops,
            { id, name: 'Task', label: `Task(${rec.description})`, status: 'running' },
          ]);
        },

        onSubagentStop: (rec) => {
          const summary = rec.status === 'completed'
            ? (rec.result ?? 'Done').split('\n')[0].slice(0, 100)
            : `Failed: ${rec.error ?? 'unknown'}`;
          setLiveOpsSync(ops => {
            const idx = [...ops].reverse().findIndex(
              o => o.name === 'Task' && o.status === 'running' && o.label.includes(rec.description),
            );
            if (idx === -1) return ops;
            const realIdx = ops.length - 1 - idx;
            return ops.map((o, i) =>
              i === realIdx ? { ...o, status: 'done' as const, detail: summary } : o,
            );
          });
        },

        onPermissionRequest: requestPermission,
        onAskUser: requestAsk,
      });

      // Clear streaming text before committing final response (prevents double-display)
      setStreamingText('');
      flushLiveOps();

      if (result) {
        pushStatic({ type: 'assistant', content: result });
        const usage = tokenTracker.current.getUsage();
        setTotalTokens(usage.inputTokens + usage.outputTokens);
        setTotalCost(tokenTracker.current.estimateCost(currentModel));
        histRef.current.push({ role: 'user', content: trimmed });
        histRef.current.push({ role: 'assistant', content: result });
        // Apply the same auto-compaction policy as the readline REPL so long
        // Ink sessions don't silently hit context limits mid-task.
        compactActiveContext(histRef.current, props.settings, currentModel, props.session);
        const now = Date.now();
        await appendMessage(props.sessionId, props.cwd, {
          role: 'user',
          content: trimmed,
          timestamp: now,
        });
        await appendMessage(props.sessionId, props.cwd, {
          role: 'assistant',
          content: result,
          timestamp: now + 1,
        });
      }
    } catch (err) {
      setStreamingText('');
      flushLiveOps();
      pushStatic({
        type: 'error',
        content: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsThinking(false);
      setSpinnerLabel('Thinking…');
      abortRef.current = null;

      // Drain queued followups. These are separate requests, so each becomes
      // its own turn — unlike steering, which extended the run above.
      const followup = props.inbox?.claimTurn()?.content
        ?? queuedMessagesRef.current.shift();
      if (followup) {
        // Small delay so the UI updates before the next run starts
        setTimeout(() => handleSubmit(followup), 100);
      }
    }
  }, [
    currentModel,
    exit,
    props,
    attachments,
    requestPermission,
    requestAsk,
    pushStatic,
    flushLiveOps,
    setLiveOpsSync,
    isThinking,
    planMode,
    autoAcceptMode,
  ]);

  const isBusy = isThinking || pendingPerm !== null || pendingAsk !== null;

  return (
    <Box flexDirection="column" paddingX={1}>

      {/* ── Committed history (Static — rendered once, never re-rendered) ── */}
      <Static items={staticItems}>
        {(entry, i) => <WelcomeLine key={i} entry={entry} />}
      </Static>

      {/* ── Todo panel ── */}
      {todos.length > 0 && <TodoPanel todos={todos} />}

      {/* ── Concurrent operations panel (Claude Code bottom panel) ── */}
      {subAgents.length > 0 && (
        <AgentsPanel
          agents={subAgents}
          selectedIndex={opsSelected}
          showDetail={opsDetail}
          isFocused={opsFocus}
        />
      )}

      {/* ── Background agents panel ── */}
      {bgAgents.length > 0 && <BackgroundAgentsPanel records={bgAgents} />}

      {/* ── Worktrees panel ── */}
      {worktrees.filter(w => w.status === 'creating' || w.status === 'active').length > 0 && (
        <WorktreePanel records={worktrees} />
      )}

      {/* ── Scheduled tasks panel ── */}
      {cronJobs.length > 0 && <ScheduledTasksPanel jobs={cronJobs} />}

      {/* ── Permission prompt ── */}
      {pendingPerm && <PermissionPrompt req={pendingPerm} onRespond={handlePerm} />}

      {/* ── AskUser prompt ── */}
      {pendingAsk && !pendingPerm && (
        <AskUserPrompt req={pendingAsk} onAnswer={handleAsk} />
      )}

      {/* ── Live ops + streaming text ── */}
      {!pendingPerm && !pendingAsk && (
        <LiveOpsPanel
          spinnerLabel={spinnerLabel}
          isThinking={isThinking}
          streamingText={streamingText}
          liveOps={liveOpsRef.current}
        />
      )}

      {/* ── Input ── */}
      {/* Input is ALWAYS visible. During processing, show a cancel hint. */}
      {isThinking && (
        <Box marginTop={0}>
          <Text dimColor>{'  (press Esc to cancel) · type to queue your next message'}</Text>
        </Box>
      )}
      {/* Ops panel hint — when there are concurrent operations and input is empty */}
      {subAgents.length > 0 && !isThinking && !opsFocus && input.trim() === '' && (
        <Box marginTop={0}>
          <Text dimColor>{'  (↓ scroll operations · → select)'}</Text>
        </Box>
      )}
      {opsFocus && !opsDetail && (
        <Box marginTop={0}>
          <Text color={CORAL} dimColor>{'  ◀ operations mode: ↑↓ scroll · → or ↵ select · ← or Esc back'}</Text>
        </Box>
      )}
      {!pendingPerm && !pendingAsk && (
        <Box marginTop={1} flexDirection="column">
          {/* Attachment chips — shown above the input while pending */}
          {attachments.length > 0 && (
            <Box flexDirection="column" marginBottom={0}>
              <Box flexDirection="row" flexWrap="wrap" gap={1}>
                {attachments.map((att, i) => (
                  <Box key={i} borderStyle="round" borderColor="cyan" paddingX={1}>
                    <Text color="cyan">{att.label}</Text>
                  </Box>
                ))}
              </Box>
              <Text dimColor>
                {'  '}
                {attachments.length} attachment{attachments.length > 1 ? 's' : ''} pending
                {'  ·  ctrl+p=add image  ctrl+x=remove last  @attach <path>=add file/dir'}
              </Text>
            </Box>
          )}
          <MultiLineInput
            value={input}
            onChange={v =>
              setInput(
                v.replace(/\x1b\[[0-9;]*~?/g, '').replace(/\[2[0-9][0-9]~/g, ''),
              )
            }
            onSubmit={handleSubmit}
            isActive={!opsFocus}
            placeholder={attachments.length > 0 ? 'Add a message for these attachments…' : 'How can I help you?'}
          />
        </Box>
      )}

      {/* ── Status bar ── */}
      <StatusBar
        tokens={totalTokens}
        cost={totalCost}
        model={currentModel}
        cwd={props.cwd}
        gitBranch={gitBranch}
        effort={props.effort}
        planMode={planMode}
        autoApprove={props.autoApprove || autoAcceptMode}
        mcpServers={mcpServers}
        settings={props.settings}
      />

    </Box>
  );
}

// ── Error Boundary ────────────────────────────────────────────────
// Catches uncaught React errors in the Ink TUI and shows a recovery message
// instead of crashing the entire process.

interface ErrorBoundaryState {
  error: Error | null;
}

class AicoErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Log to stderr so it doesn't interfere with Ink rendering
    process.stderr.write(`\n[aico] UI error: ${error.message}\n${error.stack ?? ''}\n`);
  }

  render() {
    if (this.state.error) {
      return React.createElement(
        Box,
        { flexDirection: 'column', padding: 1 },
        React.createElement(
          Text,
          { color: 'red', bold: true },
          '  aico encountered a UI error:',
        ),
        React.createElement(
          Text,
          { color: 'yellow' },
          `  ${this.state.error.message}`,
        ),
        React.createElement(Text, { dimColor: true }, ''),
        React.createElement(
          Text,
          { dimColor: true },
          '  The session is still running. Press Ctrl+C to exit.',
        ),
        React.createElement(
          Text,
          { dimColor: true },
          '  Your conversation history has been saved.',
        ),
      );
    }
    return this.props.children;
  }
}

export function startInkRepl(props: InkAppProps): Promise<void> {
  const app = React.createElement(
    AicoErrorBoundary,
    null,
    React.createElement(AicoApp, props),
  );
  const { waitUntilExit } = render(app);
  return waitUntilExit() as Promise<void>;
}
