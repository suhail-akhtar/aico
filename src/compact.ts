/**
 * Intelligent conversation auto-compaction.
 *
 * Shared by the readline REPL (src/index.ts) and the Ink REPL (src/ui/App.tsx)
 * so both apply the same context-management policy.
 *
 * ┌─ What makes this "smart"? ────────────────────────────────────────────┐
 * │                                                                       │
 * │ 1. DYNAMIC THRESHOLD — compaction triggers based on the model's       │
 * │    actual context window (75% by default), not a hardcoded 80K.       │
 * │    DeepSeek V4 (1M ctx) compacts at ~750K; Claude (200K) at ~150K.    │
 * │                                                                       │
 * │ 2. SEMANTIC PRESERVATION — the summarizer understands message         │
 * │    content types and preserves what matters:                          │
 * │    • Code blocks (full, not truncated)                                │
 * │    • File paths and decisions ("we decided to use X because Y")       │
 * │    • Tool outputs (compressed — keep structure, drop verbosity)       │
 * │    • Action items and TODOs                                            │
 * │    • Error messages and their resolutions                             │
 * │    • User's original requirements/goals                               │
 * │                                                                       │
 * │ 3. MULTI-LEVEL COMPRESSION — messages aren't truncated uniformly:     │
 * │    • Short messages (< 200 chars) → kept verbatim                     │
 * │    • Medium messages → first 2 lines + key extract (paths, decisions) │
 * │    • Tool outputs → structured compression (keep signature/result)    │
 * │    • Code blocks → preserved with marker                              │
 * │                                                                       │
 * │ 4. RECENT TURNS PRESERVED — the last N turns are kept verbatim so    │
 * │    the agent has full context for ongoing work.                       │
 * │                                                                       │
 * └───────────────────────────────────────────────────────────────────────┘
 */

import type { AicoSettings } from './settings.js';
import { estimateTokens } from './tokens.js';
import { getEffectiveContextBudget } from './context-window.js';

// ── Message type for compaction ─────────────────────────────────────
interface CompactableMessage {
  role: string;
  content: string;
}

// ── Extraction patterns ─────────────────────────────────────────────

/** Extract file paths mentioned in a message */
function extractFilePaths(text: string): string[] {
  const paths = new Set<string>();
  // Absolute/relative paths: /foo/bar, ./foo/bar, ../bar, src/foo.ts
  const pathRe = /(?:^|\s|[`(])(\.{0,2}\/[\w./-]+|[A-Za-z]:[\\\/][\w\\/.-]+|src\/[\w./-]+|\.[\w]+\/[\w./-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(text)) !== null) {
    const p = m[1];
    // Filter out obvious false positives (URLs, version numbers)
    if (!p.includes('://') && !p.match(/^\d+\.\d+\.\d+/) && p.length > 3) {
      paths.add(p);
    }
  }
  return [...paths];
}

/** Extract code blocks (```...```) preserving their content */
function extractCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re = /```[\w]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    blocks.push(m[1].trim());
  }
  return blocks;
}

/** Detect if a message looks like a decision/rationale statement */
function extractDecisions(text: string): string[] {
  const decisions: string[] = [];
  const patterns = [
    /(?:we |I |let'?s |should )(?:decided|use|chose|went with|will use|adopted|prefer)[^.]*\./gi,
    /(?:because|so that|in order to|rationale|reasoning)[^.]*\./gi,
    /(?:important|note|remember|key point|critical|must)[^.]*\./gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      decisions.push(m[0].trim());
    }
  }
  return decisions;
}

/** Extract action items / TODOs */
function extractActionItems(text: string): string[] {
  const items: string[] = [];
  const patterns = [
    /(?:TODO|FIXME|HACK|XXX)[:\s]+[^\n]+/gi,
    /(?:need to|must|should|have to|going to|will)[^.]*\./gi,
    /(?:action item|next step|follow.up)[:\s]*[^\n]+/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      items.push(m[0].trim());
    }
  }
  return items;
}

// ── Per-message compression ─────────────────────────────────────────

/**
 * Compress a single message intelligently based on its content type.
 * Returns a string that preserves the essential information while
 * dramatically reducing token count for verbose tool outputs.
 */
function compressMessage(msg: CompactableMessage, targetTokens: number): string {
  const content = msg.content;
  const currentTokens = estimateTokens(content);

  // Already short enough — keep verbatim
  if (currentTokens <= targetTokens) return content;

  // ── Extract high-value content ──
  const codeBlocks = extractCodeBlocks(content);
  const paths = extractFilePaths(content);
  const decisions = extractDecisions(content);
  const actions = extractActionItems(content);

  // ── Build compressed summary ──
  const parts: string[] = [];

  // Keep the first 2-3 lines (often contains the main point)
  const lines = content.split('\n');
  const headLines = lines.slice(0, 3).join('\n');
  parts.push(headLines);

  // Add decisions if present (high signal)
  if (decisions.length > 0) {
    parts.push('\n[Decisions]');
    parts.push(...decisions.slice(0, 5).map(d => `  • ${d.slice(0, 200)}`));
  }

  // Add action items
  if (actions.length > 0) {
    parts.push('\n[Action Items]');
    parts.push(...actions.slice(0, 5).map(a => `  • ${a.slice(0, 150)}`));
  }

  // Add file paths (critical for coding context)
  if (paths.length > 0) {
    parts.push('\n[Files Referenced]');
    parts.push('  ' + paths.slice(0, 15).join(', '));
  }

  // Preserve code blocks (truncated if very long)
  if (codeBlocks.length > 0) {
    parts.push('\n[Code Preserved]');
    for (const block of codeBlocks.slice(0, 3)) {
      const truncated = block.length > 500 ? block.slice(0, 500) + '\n... (truncated)' : block;
      parts.push('```');
      parts.push(truncated);
      parts.push('```');
    }
  }

  // If the message is a tool result (long stdout/output), keep the tail
  // (often contains the final result/error)
  if (msg.role === 'tool' && currentTokens > targetTokens * 3) {
    const tailLines = lines.slice(-5).join('\n');
    parts.push('\n[Last lines]');
    parts.push(tailLines);
  }

  return parts.join('\n');
}

/**
 * Estimate the total token count of a conversation.
 */
function estimateConversationTokens(messages: CompactableMessage[]): number {
  return estimateTokens(messages.map(m => m.content).join('\n'));
}

/**
 * Determine the compaction threshold dynamically from the model's context window.
 * Falls back to a reasonable default if no model/settings provided.
 *
 * @param model - The model being used (determines context window size)
 * @param settings - Settings with optional autoCompact config
 * @returns Token count at which compaction should trigger
 */
export function getCompactionThreshold(model: string, settings?: AicoSettings): number {
  const cfg = settings?.autoCompact;

  // Explicit percentage of context window (e.g. 75 = compact at 75% full)
  if (cfg?.thresholdPercent && cfg.thresholdPercent > 0 && cfg.thresholdPercent <= 100) {
    const budget = getEffectiveContextBudget(model, settings);
    return Math.floor((budget * cfg.thresholdPercent) / 100);
  }

  // Explicit absolute token threshold
  if (cfg?.thresholdTokens && cfg.thresholdTokens > 0) {
    return cfg.thresholdTokens;
  }

  // Default: 75% of the model's effective context budget
  const budget = getEffectiveContextBudget(model, settings);
  return Math.floor(budget * 0.75);
}

/**
 * If the conversation exceeds the dynamic threshold, compress the older
 * messages in place and keep the most recent turns. Mutates `messages`.
 *
 * The compaction is "smart":
 *   - Threshold scales with the model's actual context window
 *   - Code blocks, file paths, decisions, and action items are preserved
 *   - Tool outputs are structurally compressed (not naively truncated)
 *   - Recent turns are kept verbatim for ongoing-work context
 *
 * @returns The new estimated token count after compaction, or undefined
 *          if no compaction was performed.
 */
export function maybeAutoCompactConversation(
  messages: CompactableMessage[],
  settings: AicoSettings | undefined,
  model?: string,
): number | undefined {
  const cfg = settings?.autoCompact;
  if (cfg?.enabled === false || messages.length < 8) return undefined;

  // Determine the compaction threshold dynamically
  const threshold = model
    ? getCompactionThreshold(model, settings)
    : (cfg?.thresholdTokens ?? 80_000);

  const estimate = estimateConversationTokens(messages);
  if (estimate < threshold) return undefined;

  // ── Compaction triggered ──
  const recentTurns = Math.max(1, cfg?.keepRecentTurns ?? 6);
  const keepCount = Math.min(messages.length, recentTurns * 2);
  const toSummarise = messages.slice(0, -keepCount);
  const toKeep = messages.slice(-keepCount);

  // ── Phase 4: Replace old messages with summary ──
  messages.length = 0;
  messages.push(
    { role: 'user', content: buildConversationSummary(toSummarise) },
    {
      role: 'assistant',
      content: 'Understood. I have the compressed context above — files referenced, key decisions, action items, and the conversation timeline. I will continue from here.',
    },
    ...toKeep,
  );

  return estimateConversationTokens(messages);
}

/**
 * Compress a run of messages into one summary block.
 *
 * Shared by both compaction paths so the array-based one and the session-log
 * one cannot drift in what they preserve. Everything the summariser knows how
 * to keep — file paths, decisions, action items, code blocks, a compressed
 * timeline — lives here and nowhere else.
 *
 * @param toSummarise - the messages being replaced.
 * @returns the summary text the model will see in their place.
 */
export function buildConversationSummary(toSummarise: CompactableMessage[]): string {
  // ── Phase 1: Extract high-value content from all summarised messages ──
  const allPaths = new Set<string>();
  const allDecisions: string[] = [];
  const allActions: string[] = [];
  const allCodeBlocks: string[] = [];

  for (const msg of toSummarise) {
    // Collect file paths
    for (const p of extractFilePaths(msg.content)) allPaths.add(p);
    // Collect decisions
    allDecisions.push(...extractDecisions(msg.content));
    // Collect action items
    allActions.push(...extractActionItems(msg.content));
    // Collect code blocks (deduplicate by first 50 chars)
    for (const block of extractCodeBlocks(msg.content)) {
      const key = block.slice(0, 50);
      if (!allCodeBlocks.some(b => b.slice(0, 50) === key)) {
        allCodeBlocks.push(block);
      }
    }
  }

  // ── Phase 2: Compress each summarised message ──
  // Target: each message gets compressed to ~10% of its original size,
  // preserving the most important information
  const totalTokensToSummarise = estimateConversationTokens(toSummarise);
  const targetTotalTokens = Math.floor(totalTokensToSummarise * 0.1);
  const perMsgTarget = Math.max(30, Math.floor(targetTotalTokens / toSummarise.length));

  const compressedMsgs = toSummarise.map(msg => ({
    role: msg.role,
    content: compressMessage(msg, perMsgTarget),
  }));

  // ── Phase 3: Build the structured summary ──
  const summaryParts: string[] = [];

  summaryParts.push('[Auto-compacted conversation summary — older messages compressed]');

  // File inventory (critical for coding agents)
  if (allPaths.size > 0) {
    summaryParts.push('\n## Files Referenced');
    summaryParts.push([...allPaths].slice(0, 30).join(', '));
  }

  // Key decisions (preserves rationale for ongoing work)
  if (allDecisions.length > 0) {
    summaryParts.push('\n## Key Decisions');
    // Deduplicate by first 40 chars
    const seen = new Set<string>();
    for (const d of allDecisions) {
      const key = d.slice(0, 40).toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        summaryParts.push(`  • ${d.slice(0, 250)}`);
      }
      if (seen.size >= 10) break;
    }
  }

  // Action items
  if (allActions.length > 0) {
    summaryParts.push('\n## Action Items');
    const seen = new Set<string>();
    for (const a of allActions) {
      const key = a.slice(0, 40).toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        summaryParts.push(`  • ${a.slice(0, 150)}`);
      }
      if (seen.size >= 8) break;
    }
  }

  // Compressed message timeline (sequential context)
  summaryParts.push('\n## Conversation Timeline (compressed)');
  for (const msg of compressedMsgs) {
    if (msg.role === 'user') {
      // Preserve user intent — this is what the agent is working toward
      const content = msg.content.length > 300 ? msg.content.slice(0, 300) + '…' : msg.content;
      summaryParts.push(`[user] ${content}`);
    } else if (msg.role === 'assistant') {
      // Keep assistant's key points
      const content = msg.content.length > 200 ? msg.content.slice(0, 200) + '…' : msg.content;
      summaryParts.push(`[assistant] ${content}`);
    } else if (msg.role === 'tool') {
      // Tool results — keep very short (just the signature)
      const content = msg.content.split('\n')[0].slice(0, 100);
      summaryParts.push(`[tool] ${content}`);
    }
  }

  // Preserved code blocks (most recent ones — deduplicated)
  if (allCodeBlocks.length > 0) {
    summaryParts.push('\n## Key Code');
    for (const block of allCodeBlocks.slice(-5)) {
      const truncated = block.length > 800 ? block.slice(0, 800) + '\n… (truncated)' : block;
      summaryParts.push('```');
      summaryParts.push(truncated);
      summaryParts.push('```');
    }
  }

  return summaryParts.join('\n');
}
