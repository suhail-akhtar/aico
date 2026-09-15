# SWE-bench Lite probe — 2026-09-15

**35 of 40 instances resolved (87.5%)**, on a true random sample of SWE-bench
Lite, with AICO working blind: no dependency install, no local test
execution — pure reading of real source and editing against the real GitHub
issue text, one AICO turn per instance, model `deepseek-v4-flash`.

This is a self-run probe, not an official SWE-bench leaderboard submission.
Read the caveats below before citing this number anywhere.

## How to reproduce

```
pip install swebench datasets          # in a throwaway venv, never system Python
python scripts/swebench-select-instances.py --strategy random --count 40 --seed 20260915 --out instances.json
node scripts/swebench-live.mjs --model deepseek-v4-flash --work <workdir> --instances instances.json
# grade from WSL2 on Windows -- see scripts/swebench-live.mjs's header for why
python -m swebench.harness.run_evaluation --dataset_name SWE-bench/SWE-bench_Lite \
  --predictions_path predictions.jsonl --instance_ids <ids> --run_id <id> --report_dir .
```

## Results

| Repo | Resolved / Total |
|---|---|
| django/django | 14/16 |
| sympy/sympy | 6/7 |
| sphinx-doc/sphinx | 3/3 |
| scikit-learn/scikit-learn | 3/3 |
| pytest-dev/pytest | 3/3 |
| matplotlib/matplotlib | 2/2 |
| pylint-dev/pylint | 2/2 |
| pydata/xarray | 1/1 |
| mwaskom/seaborn | 1/1 |
| astropy/astropy | 0/1 |
| **Total** | **35/40 (87.5%)** |

Repo mix (django 40%, sympy 17.5%, ...) is the natural shape of an unbiased
random draw from SWE-bench Lite's own 300-instance composition, not a
selection choice — see `instances.json` / `instance_ids.txt` for the exact
set, and `deepseek-v4-flash.aico-probe-40.json` for the harness's own
aggregate report. Per-instance grading detail (patch, eval script, full test
output) is under `reports/`.

**Verified, not just trusted:** two instances were independently spot-checked
against their actual pytest output rather than the harness's aggregate JSON
alone. `pydata__xarray-4493` showed a genuine targeted test pass with zero
regressions. The one fully-failed repo, `astropy__astropy-14365`, shows a
real, plausible-but-wrong fix attempt (added `re.IGNORECASE` to a regex,
which is not the actual root cause) — confirming the harness is not being
lenient, and that a failure here is a genuine reasoning miss, not
infrastructure noise.

## Caveats — read before citing this number

- **n=40 of 300.** A real, unbiased sample (true random draw, no repo
  exclusions, seeded and reproducible), but still a subset. Confidence
  interval on the true resolve rate is wide at this sample size.
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

A larger run (100+ instances, ideally the full 300), a rerun on a second
random seed to check the number holds, and eventually a real submission to
the public SWE-bench leaderboard for independent verification — none of
which have been done yet.
