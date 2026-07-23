#!/usr/bin/env python3
"""Variance report: pass/total per scenario/model across repeated trials.

Usage: variance_report.py [variance-dir] [baseline-dir]
Defaults are resolved from this checkout's evals/runs directory.
"""
import json, glob, os, sys
from collections import defaultdict

def load_rates(d):
    agg = defaultdict(lambda: [0,0])  # key -> [pass,total]
    for p in glob.glob(os.path.join(d, "*", "result.json")):
        try: r = json.load(open(p))
        except: continue
        k = (r.get("scenarioId"), r.get("modelId"))
        agg[k][1] += 1
        if r.get("success"): agg[k][0] += 1
    return agg

def baseline_pass(d):
    out = {}
    for p in glob.glob(os.path.join(d, "*", "result.json")):
        try: r = json.load(open(p))
        except: continue
        k=(r.get("scenarioId"), r.get("modelId"))
        # latest by dir
        dd=os.path.basename(os.path.dirname(p))
        if k not in out or dd>out[k][1]:
            out[k]=(bool(r.get("success")), dd)
    return {k:v[0] for k,v in out.items()}

evals_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
var_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(evals_root, "runs", "sweep-variance")
base_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(evals_root, "runs", "sweep-baseline")
var = load_rates(var_dir)
base = baseline_pass(base_dir)
print(f"{'scenario':<26}{'model':<24}{'baseline':<10}{'variance':<10}verdict")
for k in sorted(var):
    s,m = k
    p,t = var[k]
    b = base.get(k)
    bstr = ("PASS" if b else "fail") if b is not None else "n/a"
    rate = f"{p}/{t}"
    # verdict
    if t==0: verdict=""
    elif p==t: verdict="stable PASS"
    elif p==0: verdict="stable FAIL (real)"
    else: verdict=f"FLAKY ({100*p//t}%)"
    print(f"{s:<26}{m:<24}{bstr:<10}{rate:<10}{verdict}")
