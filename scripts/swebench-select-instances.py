"""
Pick a small, repo-diverse subset of SWE-bench Lite instances for
scripts/swebench-live.mjs to drive AICO against.

Diversity, not difficulty, is the selection criterion here: one instance per
repo, skipping repos that need a heavy native build (matplotlib,
scikit-learn) purely to keep a quick probe quick. This is a real methodology
choice worth disclosing wherever the results are reported -- it is not a
uniform random sample of SWE-bench Lite, and a larger run should include
those repos.

Usage:
    pip install datasets   # in a throwaway venv, never the system Python
    python scripts/swebench-select-instances.py --count 5 --out /tmp/aico-swebench/instances.json
"""
import argparse
import json

from datasets import load_dataset

parser = argparse.ArgumentParser()
parser.add_argument("--count", type=int, default=5)
parser.add_argument("--out", default="instances.json")
parser.add_argument("--skip-repos", nargs="*", default=["matplotlib/matplotlib", "scikit-learn/scikit-learn"])
args = parser.parse_args()

ds = load_dataset("princeton-nlp/SWE-bench_Lite", split="test")
print("total instances:", len(ds))

seen_repos = set()
picked = []
for row in ds:
    if row["repo"] in seen_repos or row["repo"] in args.skip_repos:
        continue
    seen_repos.add(row["repo"])
    picked.append(row)
    if len(picked) >= args.count:
        break

with open(args.out, "w", encoding="utf-8") as f:
    json.dump([dict(r) for r in picked], f, indent=2)

for r in picked:
    print(r["instance_id"], "|", r["repo"], "|", r["base_commit"][:10])
