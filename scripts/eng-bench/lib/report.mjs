/**
 * The eng-bench results as a Markdown page a person can read in one sitting,
 * and the comparison against an earlier results file.
 *
 * The JSON is the record; this is a view of it. Delegation briefs are printed
 * in full (collapsed) because reviewing *how* the agent briefed its
 * sub-agents is the point of task 6 and cannot be summarised by a number.
 */

const usd = (n) => (n == null ? '—' : `$${Number(n).toFixed(3)}`);
const min = (ms) => (ms == null ? '—' : `${(ms / 60_000).toFixed(1)}m`);
const k = (n) => (n == null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

function endLabel(e) {
  if (!e) return '—';
  if (e.kind === 'error') return e.code === 'iteration-cap' ? 'step cap' : `error: ${esc(e.message).slice(0, 40)}`;
  if (e.kind === 'aborted') return /cost limit/.test(e.cause ?? '') ? 'USD cap' : `aborted`;
  return e.kind;
}

/** Mean of each task's runs. */
export function aggregate(results) {
  const by = new Map();
  for (const r of results) {
    if (!by.has(r.task)) by.set(r.task, []);
    by.get(r.task).push(r);
  }
  return [...by.entries()].map(([task, runs]) => {
    const mean = (f) => { const xs = runs.map(f).filter((x) => typeof x === 'number'); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
    return {
      task, title: runs[0].title, soft: runs[0].soft, runs: runs.length,
      score: mean((r) => r.grade.score), passRate: mean((r) => (r.grade.pass ? 1 : 0)),
      costUsd: mean((r) => r.metrics?.costUsd), wallMs: mean((r) => r.turn?.wallMs), iterations: mean((r) => r.metrics?.iterations),
      inputTokens: mean((r) => r.metrics?.tokens?.input), outputTokens: mean((r) => r.metrics?.tokens?.output),
    };
  });
}

export function renderMarkdown(doc, previous) {
  const { meta, results } = doc;
  const L = [];
  L.push(`# AICO eng-bench — ${meta.label ?? 'results'}`);
  L.push('');
  L.push(`- **When:** ${meta.startedAt} → ${meta.finishedAt ?? '(running)'}`);
  L.push(`- **Engine:** \`${meta.entry}\` (AICO ${meta.aicoVersion ?? '?'}${meta.git ? `, ${meta.git}` : ''})`);
  L.push(`- **Model:** ${meta.settings?.model ?? '?'} · sub-agents: ${JSON.stringify(meta.settings?.agentModels ?? {})} · judge: ${meta.judgeModel}`);
  L.push(`- **Caps per task:** ${meta.settings?.maxIterations} steps, $${meta.settings?.safetyLimits?.maxCostPerSession} session / $${meta.settings?.safetyLimits?.maxCostPerSubagent} per sub-agent, steer at ${meta.softMinutes} min, cancel at ${meta.hardMinutes} min`);
  L.push(`- **Runs:** ${meta.runs} · **tasks:** ${meta.tasks.join(', ')}`);
  if (meta.regradedAt) L.push(`- **Re-graded** ${meta.regradedAt} without re-running the agent: ${meta.regradeNote}`);
  const agentCost = results.reduce((n, r) => n + (r.metrics?.costUsd ?? 0), 0);
  const judgeCost = results.reduce((n, r) => n + (r.grade?.extra?.judge?.costUsd ?? 0), 0);
  const wall = results.reduce((n, r) => n + (r.turn?.wallMs ?? 0), 0);
  L.push(`- **Spend:** agent ${usd(agentCost)} + judge ${usd(judgeCost)} = **${usd(agentCost + judgeCost)}** · agent wall time ${min(wall)}`);
  L.push('');
  L.push('Score = weighted share of the task\'s checks that passed; **Pass** = every check passed. *Soft* tasks are graded by rubric + LLM judge, not tests — read them as a trend.');
  L.push('');
  L.push('| Run | Task | Score | Pass | Turn end | Wall | Steps (sub) | Tokens in / out / cached | USD | Self-verified | Asked | Top tools |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const m = r.metrics ?? {};
    const v = m.verification ?? {};
    const verified = `tests ${v.ranTests ?? 0}${v.testsAfterLastEdit ? ' ✓final' : ''} · server ${v.startedServer ?? 0} · http ${v.httpProbes ?? 0}`;
    const top = Object.entries(m.toolCounts ?? {}).slice(0, 4).map(([n, c]) => `${n} ${c}`).join(', ');
    L.push(`| ${r.run} | ${r.title}${r.soft ? ' *(soft)*' : ''} | ${pct(r.grade.score)} (${r.grade.passed}/${r.grade.total}) | ${r.grade.pass ? 'yes' : 'no'} | ${endLabel(m.turnEnd)}${r.turn?.steered ? ', steered' : ''}${r.turn?.cancelled ? ', cancelled' : ''} | ${min(r.turn?.wallMs)} | ${m.iterations ?? '—'} (${m.subIterations ?? 0}) | ${k(m.tokens?.input)} / ${k(m.tokens?.output)} / ${k(m.tokens?.cached)} | ${usd(m.costUsd)} | ${verified} | ${r.turn?.answers ?? 0} | ${esc(top)} |`);
  }
  L.push('');

  if (doc.meta.runs > 1) {
    L.push('## Mean across runs');
    L.push('');
    L.push('| Task | Runs | Mean score | Pass rate | Mean USD | Mean wall | Mean steps |');
    L.push('|---|---|---|---|---|---|---|');
    for (const a of aggregate(results)) L.push(`| ${a.title} | ${a.runs} | ${pct(a.score)} | ${pct(a.passRate)} | ${usd(a.costUsd)} | ${min(a.wallMs)} | ${a.iterations?.toFixed(1) ?? '—'} |`);
    L.push('');
  }

  if (previous) {
    L.push(`## Compared with ${previous.meta?.label ?? 'previous'} (${previous.meta?.startedAt ?? '?'})`);
    L.push('');
    const before = new Map(aggregate(previous.results).map((a) => [a.task, a]));
    L.push('| Task | Score | Δ | USD | Δ | Steps | Δ | Wall | Δ |');
    L.push('|---|---|---|---|---|---|---|---|---|');
    const d = (a, b, f = (x) => x.toFixed(2)) => (a == null || b == null ? '—' : `${a - b >= 0 ? '+' : ''}${f(a - b)}`);
    for (const a of aggregate(results)) {
      const b = before.get(a.task) ?? {};
      L.push(`| ${a.title} | ${pct(a.score)} | ${d(a.score, b.score, (x) => `${Math.round(x * 100)}pt`)} | ${usd(a.costUsd)} | ${d(a.costUsd, b.costUsd, (x) => x.toFixed(3))} | ${a.iterations?.toFixed(1) ?? '—'} | ${d(a.iterations, b.iterations, (x) => x.toFixed(1))} | ${min(a.wallMs)} | ${d(a.wallMs, b.wallMs, (x) => `${(x / 60_000).toFixed(1)}m`)} |`);
    }
    const moved = Object.keys({ ...meta.settings, ...previous.meta?.settings })
      .filter((key) => JSON.stringify(meta.settings?.[key]) !== JSON.stringify(previous.meta?.settings?.[key]));
    if (moved.length) L.push('', `**Warning — settings differ between the two runs:** ${moved.join(', ')}. Deltas may not be the change under test.`);
    L.push('');
  }

  L.push('## Per task');
  for (const r of results) {
    const m = r.metrics ?? {};
    L.push('');
    L.push(`### ${r.title} — run ${r.run}`);
    L.push('');
    L.push(`Project: \`${r.paths.project}\` · logs: \`${r.paths.logs}\``);
    if (r.error) L.push('', `**Runner error:** ${r.error}`);
    if (r.previousGrade) L.push('', `Re-graded: the original grade was ${r.previousGrade.passed}/${r.previousGrade.total}${r.previousGrade.failed.length ? ` (failed: ${r.previousGrade.failed.join('; ')})` : ''}.`);
    const failed = r.grade.checks.filter((c) => !c.ok);
    L.push('', failed.length ? '**Failed checks:**' : '**All checks passed.**');
    for (const c of failed) L.push(`- ${c.id}${c.detail ? ` — ${esc(c.detail).slice(0, 300)}` : ''}`);
    const p = m.planning ?? {};
    const w = m.waste ?? {};
    L.push('');
    L.push(`- Planning: TodoWrite ${p.todoWrites ?? 0}, ProposePlan ${p.proposePlan ?? 0}, skills [${(p.skills ?? []).join(', ')}]; first tools: ${(m.firstTools ?? []).join(' → ')}`);
    L.push(`- Verification: ${JSON.stringify(m.verification ?? {})}`);
    L.push(`- Waste: re-reads ${w.rereads ?? 0}, tool errors ${m.toolErrors ?? 0}, masks ${w.masks ?? 0}, repeated commands ${(w.repeatedCommands ?? []).map((c) => `\`${esc(c.command).slice(0, 60)}\`×${c.times}`).join(', ') || 'none'}`);
    L.push(`- Tool calls: ${m.toolCalls ?? 0} main ${JSON.stringify(m.toolCounts ?? {})}; sub-agents ${JSON.stringify(m.subToolCounts ?? {})}`);
    if (r.grade.extra?.judge) {
      const j = r.grade.extra.judge;
      L.push(`- Judge (${j.model ?? '—'}, ${usd(j.costUsd)}): mean ${j.mean ?? '—'} ${j.scores ? JSON.stringify(j.scores) : ''}${j.error ? ` — ${esc(j.error).slice(0, 200)}` : ''}`);
      if (j.notes) for (const [crit, note] of Object.entries(j.notes)) L.push(`  - ${crit}: ${esc(note)}`);
    }
    if (r.grade.extra?.stack) L.push(`- Stack chosen: ${r.grade.extra.stack}`);
    const dl = m.delegation;
    if (dl?.delegated) {
      L.push(`- Delegation: ${dl.taskCalls} Task, ${dl.investigateCalls} Investigate, ${dl.subSessions} sub-sessions; after delegating the parent did ${JSON.stringify(dl.reviewedAfter)}`);
      for (const t of dl.tasks) {
        const s = Object.entries(t.signals).filter(([, v]) => v).map(([n]) => n).join(', ') || 'none';
        L.push('', `<details><summary>Task brief: "${esc(t.description)}" (${t.subagentType}, ${t.chars} chars; signals: ${s})</summary>`, '', '```text', t.prompt, '```', '</details>');
      }
      for (const i of dl.investigations) L.push('', `<details><summary>Investigate: ${esc(i.question).slice(0, 100)}</summary>`, '', ...i.angles.map((a) => `- ${esc(a)}`), '</details>');
    } else if (dl) {
      L.push('- Delegation: none');
    }
    if (m.finalMessage) L.push('', '<details><summary>Agent\'s final message</summary>', '', '```text', m.finalMessage.slice(0, 2500), '```', '</details>');
  }
  L.push('');
  return L.join('\n');
}
