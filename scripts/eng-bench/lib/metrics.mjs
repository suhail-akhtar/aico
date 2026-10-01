/**
 * What the agent *did*, read from its session logs — never from its report.
 *
 * The log is the truth (AGENTS.md §4.8), so everything here is derived from
 * `tool/call`, `tool/result`, `step/start`, `assistant/message` and `turn/end`
 * events of the main session and of every delegated `sub-*` session. The
 * numbers exist to answer the questions a prompt or tool change is meant to
 * move: did it verify its own work, did it plan, how did it brief the agents
 * it delegated to, and where did the tokens go.
 *
 * Heuristics are labelled as such. "Ran tests" means a shell command that
 * looks like a test runner was executed — not that the tests passed; the
 * graders decide that independently.
 */

const TEST_CMD = /\b(npm|pnpm|yarn)(\.cmd)?\s+(run\s+)?test\b|\bnode\s+(--[\w-]+(=\S+)?\s+)*--test\b|\bpytest\b|python[0-9.]*\s+-m\s+(pytest|unittest)|\bvitest\b|\bjest\b|\bmocha\b/i;
const SERVER_CMD = /\b(npm|pnpm|yarn)(\.cmd)?\s+(run\s+)?(start|dev|serve)\b|\bnode\s+[^|&;]*\b(server|app|index|main)\.m?js\b|\buvicorn\b|flask\s+run|python[0-9.]*\s+[^|&;]*\b(app|main|server|run|manage)\.py|Start-Process/i;
const HTTP_CMD = /\bcurl(\.exe)?\b|Invoke-WebRequest|Invoke-RestMethod|\bwget\b|\bfetch\(|http\.request|\bhttpie\b|\biwr\b|\birm\b/i;
const EDIT_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'WorkspaceWrite']);

function parseArgs(raw) {
  try { return JSON.parse(raw ?? '{}'); } catch { return {}; }
}

function sumUsage(events) {
  const u = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, requests: 0 };
  for (const e of events) {
    if (e.type !== 'assistant/message' || !e.data?.usage) continue;
    u.inputTokens += e.data.usage.inputTokens ?? 0;
    u.outputTokens += e.data.usage.outputTokens ?? 0;
    u.cachedTokens += e.data.usage.cachedTokens ?? 0;
    u.requests++;
  }
  return u;
}

function countBy(items, key) {
  const out = {};
  for (const i of items) out[key(i)] = (out[key(i)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

/** Shell commands and the tool that ran them. */
function commandsOf(calls) {
  return calls
    .filter((c) => c.name === 'Bash' || c.name === 'Terminal')
    .map((c) => ({ seq: c.seq, tool: c.name, command: String(parseArgs(c.arguments).command ?? '') }));
}

function analyse(events) {
  const calls = events.filter((e) => e.type === 'tool/call').map((e) => ({ seq: e.seq, ...e.data }));
  const results = events.filter((e) => e.type === 'tool/result').map((e) => ({ seq: e.seq, ...e.data }));
  const cmds = commandsOf(calls);
  const lastEdit = calls.filter((c) => EDIT_TOOLS.has(c.name)).map((c) => c.seq).pop() ?? -1;
  const testRuns = cmds.filter((c) => TEST_CMD.test(c.command));
  const checkTools = calls.filter((c) => c.name === 'RunChecks' || c.name === 'VerifyApp');

  // Token-waste signals: the same file read again, the same command run again,
  // and which tools' output filled the context.
  const reads = calls.filter((c) => c.name === 'Read').map((c) => String(parseArgs(c.arguments).file_path ?? parseArgs(c.arguments).path ?? ''));
  const readCounts = countBy(reads, (p) => p.replace(/\\/g, '/').toLowerCase());
  const rereads = Object.values(readCounts).reduce((n, k) => n + Math.max(0, k - 1), 0);
  const cmdCounts = countBy(cmds, (c) => c.command.trim());
  const repeatedCommands = Object.entries(cmdCounts).filter(([, k]) => k > 1)
    .map(([command, times]) => ({ command: command.replace(/^cd\s+("[^"]*"|\S+)\s*(&&|;)\s*/, '').slice(0, 160), times }));
  const resultChars = {};
  for (const r of results) resultChars[r.name] = (resultChars[r.name] ?? 0) + (r.content?.length ?? 0);

  return {
    steps: events.filter((e) => e.type === 'step/start').length,
    usage: sumUsage(events),
    toolCalls: calls.length,
    toolCounts: countBy(calls, (c) => c.name),
    toolErrors: results.filter((r) => r.isError).length,
    firstTools: calls.slice(0, 15).map((c) => c.name),
    verification: {
      ranTests: testRuns.length,
      testsAfterLastEdit: testRuns.some((c) => c.seq > lastEdit) || checkTools.some((c) => c.seq > lastEdit),
      startedServer: cmds.filter((c) => SERVER_CMD.test(c.command)).length,
      httpProbes: cmds.filter((c) => HTTP_CMD.test(c.command)).length,
      runChecks: calls.filter((c) => c.name === 'RunChecks').length,
      verifyApp: calls.filter((c) => c.name === 'VerifyApp').length,
    },
    planning: {
      todoWrites: calls.filter((c) => c.name === 'TodoWrite').length,
      proposePlan: calls.filter((c) => c.name === 'ProposePlan').length,
      skills: calls.filter((c) => c.name === 'Skill').map((c) => parseArgs(c.arguments).name ?? parseArgs(c.arguments).skill ?? '?'),
    },
    waste: { rereads, repeatedCommands: repeatedCommands.slice(0, 10), resultChars, masks: events.filter((e) => e.type === 'context/masked').length },
    commands: cmds.map((c) => c.command.slice(0, 300)),
    calls,
  };
}

/**
 * The briefs the parent wrote for the agents it delegated to — the exact
 * `Task` prompts and `Investigate` angles — plus cheap signals of brief quality
 * for a human reviewer to start from (not a score).
 */
function delegationOf(mainCalls, subs) {
  const tasks = mainCalls.filter((c) => c.name === 'Task').map((c) => {
    const a = parseArgs(c.arguments);
    const prompt = String(a.prompt ?? a.agent_spec?.instructions ?? '');
    return {
      seq: c.seq,
      description: a.description ?? '',
      subagentType: a.subagent_type ?? (a.agent_spec ? 'agent_spec' : a.agent_name ?? 'general'),
      model: a.model ?? null,
      chars: prompt.length,
      signals: {
        namesPaths: /[\w.-]+\/[\w./-]+|\b[\w-]+\.(m?js|ts|py|json|md)\b/.test(prompt),
        statesAcceptance: /\b(test|tests|pass|passing|must|acceptance|done when|verify|expected)\b/i.test(prompt),
        namesCommand: /\b(npm (run )?test|node --test|pytest)\b/i.test(prompt),
        statesConstraints: /\b(do not|don't|must not|only|keep|without changing|public api)\b/i.test(prompt),
        asksForReport: /\b(report|summar|return|reply with|tell me)\b/i.test(prompt),
      },
      prompt,
    };
  });
  const investigations = mainCalls.filter((c) => c.name === 'Investigate').map((c) => {
    const a = parseArgs(c.arguments);
    return { seq: c.seq, question: a.question ?? '', angles: a.angles ?? [] };
  });
  const lastDelegation = Math.max(-1, ...tasks.map((t) => t.seq), ...investigations.map((i) => i.seq));
  const after = mainCalls.filter((c) => c.seq > lastDelegation);
  return {
    delegated: tasks.length + investigations.length > 0,
    taskCalls: tasks.length,
    investigateCalls: investigations.length,
    subSessions: subs.length,
    subUsage: subs.reduce((u, s) => {
      const x = sumUsage(s.events);
      return { inputTokens: u.inputTokens + x.inputTokens, outputTokens: u.outputTokens + x.outputTokens, cachedTokens: u.cachedTokens + x.cachedTokens, requests: u.requests + x.requests };
    }, { inputTokens: 0, outputTokens: 0, cachedTokens: 0, requests: 0 }),
    // Did the parent look at the work after it came back, or take the report on trust?
    reviewedAfter: lastDelegation < 0 ? null : {
      reads: after.filter((c) => c.name === 'Read' || c.name === 'Grep').length,
      testRuns: commandsOf(after).filter((c) => TEST_CMD.test(c.command)).length,
      edits: after.filter((c) => EDIT_TOOLS.has(c.name)).length,
    },
    tasks,
    investigations,
  };
}

/** Everything the report needs about one task run. */
export function summarise({ main, subs }, sessionUsage = {}) {
  const m = analyse(main);
  const subAnalyses = subs.map((s) => ({ id: s.id, ...analyse(s.events) }));
  const end = [...main].reverse().find((e) => e.type === 'turn/end')?.data?.reason ?? null;
  const finalMessage = [...main].reverse().find((e) => e.type === 'assistant/message' && e.data?.content)?.data?.content ?? '';
  const subToolCounts = {};
  for (const s of subAnalyses) for (const [k, v] of Object.entries(s.toolCounts)) subToolCounts[k] = (subToolCounts[k] ?? 0) + v;
  const logUsage = [m.usage, ...subAnalyses.map((s) => s.usage)].reduce((a, b) => ({
    inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens, requests: a.requests + b.requests,
  }));
  return {
    turnEnd: end,
    iterations: m.steps,
    subIterations: subAnalyses.reduce((n, s) => n + s.steps, 0),
    tokens: {
      // The engine's tracker (includes sub-agents) is authoritative; the log
      // sum is a cross-check that should agree within rounding.
      input: sessionUsage.inputTokens ?? logUsage.inputTokens,
      output: sessionUsage.outputTokens ?? logUsage.outputTokens,
      cached: sessionUsage.cachedTokens ?? logUsage.cachedTokens,
      fromLogs: logUsage,
    },
    costUsd: sessionUsage.costUsd ?? null,
    toolCalls: m.toolCalls,
    toolCounts: m.toolCounts,
    subToolCounts,
    toolErrors: m.toolErrors + subAnalyses.reduce((n, s) => n + s.toolErrors, 0),
    firstTools: m.firstTools,
    verification: m.verification,
    planning: m.planning,
    waste: m.waste,
    commands: m.commands,
    delegation: delegationOf(m.calls, subs),
    finalMessage: finalMessage.slice(0, 4000),
  };
}
