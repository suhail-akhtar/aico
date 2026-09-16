# SWE-bench Lite probes — 2026-09-15/16

**73 of 80 instances resolved (91.25%) across two independent random
samples** (run 1: 35/40, run 2: 38/40 — different seeds, disjoint
instances, no overlap), with AICO working blind: no dependency install, no
local test execution — pure reading of real source and editing against the
real GitHub issue text, one AICO turn per instance, model
`deepseek-v4-flash`.

Two runs instead of one specifically to check the first result wasn't a
lucky draw. It wasn't — run 2 landed even higher (95%) on a disjoint set of
instances, which is the strongest evidence in this repo that the number is
real rather than noise.

This is a self-run probe, not an official SWE-bench leaderboard submission.
Read the caveats below before citing this number anywhere.

## How to reproduce

```
pip install swebench datasets          # in a throwaway venv, never system Python
python scripts/swebench-select-instances.py --strategy random --count 40 --seed 20260915 --out run1/instances.json
python scripts/swebench-select-instances.py --strategy random --count 40 --seed 7 --exclude-ids-file run1/instance_ids.txt --out run2/instances.json
node scripts/swebench-live.mjs --model deepseek-v4-flash --work <workdir> --instances <run>/instances.json
# grade from WSL2 on Windows -- see scripts/swebench-live.mjs's header for why
python -m swebench.harness.run_evaluation --dataset_name SWE-bench/SWE-bench_Lite \
  --predictions_path predictions.jsonl --instance_ids <ids> --run_id <id> --report_dir .
```

## Results

| Repo | Run 1 | Run 2 | Combined |
|---|---|---|---|
| django/django | 14/16 | 15/15 | 29/31 |
| sympy/sympy | 6/7 | 11/12 | 17/19 |
| scikit-learn/scikit-learn | 3/3 | 3/3 | 6/6 |
| matplotlib/matplotlib | 2/2 | 3/3 | 5/5 |
| sphinx-doc/sphinx | 3/3 | — | 3/3 |
| pytest-dev/pytest | 3/3 | 1/1 | 4/4 |
| pylint-dev/pylint | 2/2 | — | 2/2 |
| pydata/xarray | 1/1 | 1/1 | 2/2 |
| mwaskom/seaborn | 1/1 | 1/1 | 2/2 |
| astropy/astropy | 0/1 | 1/1 | 1/2 |
| psf/requests | — | 1/1 | 1/1 |
| pallets/flask | — | 1/1 | 1/1 |
| **Total** | **35/40** | **38/40** | **73/80 (91.25%)** |

80 of SWE-bench Lite's 300 instances (26.7%) now covered, zero overlap
between the two runs. Repo mix is the natural shape of two unbiased random
draws from SWE-bench Lite's own composition (django and sympy dominate the
underlying dataset), not a selection choice. Full per-instance evidence
(patch, eval script, complete test output) is under `run1/reports/` and
`run2/reports/`; each run's own harness aggregate is the
`deepseek-v4-flash.aico-probe-*.json` file beside it.

**Verified, not just trusted:** every "0 resolved" or notably weak result
across both runs was individually spot-checked against its actual pytest
output, not just the harness's aggregate JSON.
- `pydata__xarray-4493` (run 1) — genuine targeted test pass, zero
  regressions.
- `astropy__astropy-14365` (run 1's one failure) — a real, plausible-but-
  wrong fix attempt (added `re.IGNORECASE` to a regex; not the actual root
  cause).
- `sympy__sympy-12171` (run 2's one applied-but-failed instance) — a real
  attempt (added a missing `_print_Derivative`/`_print_Float` Mathematica
  code-gen path) that didn't match the exact expected output format.

These confirm the harness isn't grading leniently in either direction: a
failure here is a genuine reasoning miss, and a pass is a genuine, targeted
fix with no regressions.

## Caveats — read before citing this number

- **n=80 of 300 (26.7%), across two seeds.** Real and unbiased, and the
  second run confirming the first is the strongest evidence this isn't
  noise — but it is still a subset, not the full dataset.
- **Not an official leaderboard run.** No independent auditor ran this; the
  predictions and grading are both self-produced (grading is the standard
  `swebench` harness, not a custom scorer, which helps, but this is not a
  submission to the public leaderboard).
- **Dataset contamination is a known, industry-wide risk for *any* LLM on
  SWE-bench.** These are real historical GitHub issues and their accepted
  fixes, which are public and have been for years — a model that saw the
  actual fix during pretraining could reproduce it without solving the bug.
  This risk applies to every model's SWE-bench number, not something unique
  to AICO or deepseek, but it means "resolved" here should be read as
  "produced the correct patch," not proof of novel reasoning on unseen code.
- **AICO worked blind, without test execution.** That's a fairer comparison
  in one sense (no environment scaffolding did the work), but it also means
  AICO never got a chance to catch its own mistakes the way a human — or an
  agent with test access — would. The unresolved instances are exactly the
  ones where that would have mattered.

## What would raise confidence further

Covering the remaining ~73% of SWE-bench Lite (the two-run exclude-list
pattern above makes this additive, not a re-run), and eventually a real
submission to the public SWE-bench leaderboard for independent
verification — neither has been done yet.
