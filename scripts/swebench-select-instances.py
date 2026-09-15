"""
Pick a subset of SWE-bench Lite instances for scripts/swebench-live.mjs to
drive AICO against.

Two strategies:
  --strategy random   True unrandom-biased sample: shuffle everything with a
                       fixed seed, take the first N. No repo is excluded. Use
                       this for any result meant to be cited as evidence of
                       real-world capability -- it is the only strategy that
                       is not itself a form of cherry-picking.
  --strategy diverse   One instance per repo (skipping any in --skip-repos).
                       Good for a fast smoke-test across variety, bad for a
                       capability claim: it silently caps the sample at the
                       repo count and was the strategy behind the first,
                       n=5 probe (see project_swebench_probe_0915 memory).

Usage:
    pip install datasets   # in a throwaway venv, never the system Python
    python scripts/swebench-select-instances.py --strategy random --count 40 --seed 20260915 --out instances.json
"""
import argparse
import json
import random

from datasets import load_dataset

parser = argparse.ArgumentParser()
parser.add_argument("--count", type=int, default=5)
parser.add_argument("--out", default="instances.json")
parser.add_argument("--strategy", choices=["random", "diverse"], default="random")
parser.add_argument("--seed", type=int, default=20260915)
parser.add_argument("--skip-repos", nargs="*", default=[])
args = parser.parse_args()

ds = load_dataset("princeton-nlp/SWE-bench_Lite", split="test")
print("total instances:", len(ds))

rows = [r for r in ds if r["repo"] not in args.skip_repos]

if args.strategy == "random":
    rng = random.Random(args.seed)
    rng.shuffle(rows)
    picked = rows[: args.count]
else:
    seen_repos = set()
    picked = []
    for row in rows:
        if row["repo"] in seen_repos:
            continue
        seen_repos.add(row["repo"])
        picked.append(row)
        if len(picked) >= args.count:
            break

with open(args.out, "w", encoding="utf-8") as f:
    json.dump([dict(r) for r in picked], f, indent=2)

by_repo = {}
for r in picked:
    by_repo[r["repo"]] = by_repo.get(r["repo"], 0) + 1
print(f"picked {len(picked)} instances ({args.strategy}, seed={args.seed}) across {len(by_repo)} repos:")
for repo, n in sorted(by_repo.items(), key=lambda kv: -kv[1]):
    print(f"  {repo}: {n}")
