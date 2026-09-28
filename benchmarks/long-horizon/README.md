# Long-horizon context management: live probe (2026-09-28)

**Every run was fully correct (140 of 140 values, across 6 runs on 2
models, follow-up turns included).** Under deliberately tight limits,
runs survived and stayed correct. At default settings, context
management halved the peak request size. It did **not** reliably change
cost on these mid-size tasks. The finding that mattered most came from a
failure, described under "What the first rounds found".

Probe: [`scripts/long-horizon-live.mjs`](../../scripts/long-horizon-live.mjs).
Run it as `node scripts/long-horizon-live.mjs <model> tight|default|off <files>`.

## The task

A folder of report files, each about 9 KB of filler with exactly one
`ACCESS CODE: …` line at a random position. The instructions:

- Read every file with the Read tool, one per step (no Grep, no Bash
  search).
- Track progress with TodoWrite.
- Write `results.json`, mapping each file name to its code.
- Then a second turn: add `"total"` and name the file with the longest
  code.

This forces a context that grows with every step, and correctness is
checked against ground truth, not against what the model says it did:

- every code in `results.json` must match its file;
- the follow-up must produce `total = N` and name the right file;
- the session log records what the manager did and how each turn
  ended.

Modes:

- **off**: no context management and no compaction; the baseline.
- **default**: settings as shipped.
- **tight**: limits forced low (compaction at about 16K tokens above
  the fixed request overhead), to prove a run survives real pressure.

## Final results (final build)

| Model | Mode | Files | Correct | Steps | Masks / condensations | Peak request | Input tokens | Cache hit | Est. cost* |
|---|---|---|---|---|---|---|---|---|---|
| deepseek-flash | tight | 10 | 10/10 | 19 | 0 / 1 | 60K | 0.83M | 89% | $0.022 |
| deepseek-flash | off | 30 | 30/30 | 39 | 0 / 0 | 201K | 4.91M | 96% | $0.057 |
| deepseek-flash | default | 30 | 30/30 | 46 | 4 / 0 | 115K | 3.64M | 90% | $0.085 |
| gpt-6-luna | tight | 10 | 10/10 | 24 | 0 / 1 | 51K | 0.71M | 53% | $0.039 |
| gpt-6-luna | off | 30 | 30/30 | 46 | 0 / 0 | 201K | 5.33M | 14% | $0.471 |
| gpt-6-luna | default | 30 | 30/30 | 73 | 3 / 0 | 105K | 5.21M | 22% | $0.431 |

\*Costs are computed from recorded token counts at published rates, not
from a bill:

- **deepseek-flash**, off-peak: $0.15 cache miss, $0.003 hit, $0.60
  output per 1M tokens. These runs were in DeepSeek's peak hours, which
  bill double; the comparison between modes holds either way.
- **gpt-6-luna**, short-context: $0.10 input, $0.01 cached, $0.50
  output.

Every turn in every run ended `completed`.

### Reading it honestly

- **Peak context roughly halved** at defaults: 201K → 115K and
  200K → 105K. That is the point of the feature. A run gets further
  inside a fixed window, and the model works from less stale material.
- **Cost was a wash on these tasks.** An earlier DeepSeek pair of the
  same shape, on a build from before the final fixes, went the other way
  ($0.051 managed vs $0.067 off). Most of
  the swing is how much text the model chose to write, which varies run
  to run. Prompt caching makes a long, unmasked context cheap to re-send:
  a DeepSeek cache miss costs 50× a hit, and OpenAI's and Anthropic's
  10×. Every mask breaks that cache once, so masking early to save money
  does not pay. The defaults therefore start masking only past half the
  window, capped at 100K tokens, and in batches.
- **OpenAI's cache hit rate is low even unmanaged** (14%, against 96%
  for DeepSeek on the same harness). That is a provider-path issue,
  separate from context management. The missing `prompt_cache_key` was
  found and fixed here; the rest is still under investigation.

## What the first rounds found

The first live rounds failed in instructive ways. Each failure became a
fix, and the table above is from after all of them.

1. **A condensation made the context bigger** (~39,680 → ~40,161
   tokens). It folded one already-masked step into a longer handoff.
   Condensations are now skipped unless they shrink the context.
2. **Masking fired on almost every step.** The keep window counted
   every result, so tiny todo updates pushed real output out. Masks now
   come in batches, and only substantial output counts toward the
   window.
3. **The model re-read what was cleared: 55 reads for 10 files.** The
   placeholder said "call the tool again". The model is now warned once,
   before anything is cleared, to keep what it will need, and the
   placeholder no longer invites re-reading. The tight run then took
   12–13 reads.
4. **gpt-6-luna never finished: 162 reads for 30 files, stopped at the
   step cap.** It reads about eight files at once, so a window counted
   in results masked output one step after the model first saw it. The
   study this design follows ("The Complexity Trap", arXiv 2508.21433)
   keeps ten steps of observations. Output from the last 8 steps is now
   never masked. The same run then went 30/30.
5. **Provider bugs uncovered along the way** (all fixed):
   - gpt-6 models could not use tools at all; they need the Responses
     API.
   - `deepseek-flash` was treated as a 128K window (it is 1M), and gpt-6
     as an assumed 128K (it is 1.05M).
   - gpt-5.6 and gpt-6 had wrong or missing prices.
   - The Responses path sent no `prompt_cache_key`.

## Caveats

- **Self-run**, on one synthetic task shape: many reads, one output
  file. Real work has more varied context growth.
- **Anthropic was not run live.** The key in this environment was
  rejected (401). The one-hour prefix cache and the cost accounting for
  it are verified against a local HTTP server that records the exact
  request body (`test-harness.mjs`), not against the real API.
- **n = 1 per cell.** Correctness held across all 6 final runs and the
  earlier rounds, but the cost differences are within run-to-run
  variance, and are reported as such.
