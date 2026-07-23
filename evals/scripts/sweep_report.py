#!/usr/bin/env python3
"""Aggregate eval sweep results into a model x scenario pass matrix + overall pass rate.
Usage:
  _sweep_report.py <dir>                 # summarize one sweep dir
  _sweep_report.py <baseDir> <afterDir>  # diff two sweeps (improvement)
Reads <dir>/<scenario>-*/result.json (top-level: scenarioId, modelId, success, reason, durationMs).
"""
import os, sys, json, glob
from collections import defaultdict

def load(d):
    rows = []
    for p in glob.glob(os.path.join(d, "*", "result.json")):
        try:
            r = json.load(open(p))
        except Exception:
            continue
        rows.append({
            "scenario": r.get("scenarioId"),
            "model": r.get("modelId"),
            "ok": bool(r.get("success")),
            "reason": (r.get("reason") or "")[:80],
            "sec": round((r.get("durationMs") or 0)/1000),
            "dir": os.path.basename(os.path.dirname(p)),
        })
    return rows

def summarize(rows, title):
    scen = sorted({r["scenario"] for r in rows})
    models = sorted({r["model"] for r in rows})
    # latest result per (scenario,model) by dir name (timestamped) -> take max
    cell = {}
    for r in rows:
        k = (r["scenario"], r["model"])
        if k not in cell or r["dir"] > cell[k]["dir"]:
            cell[k] = r
    npass = sum(1 for r in cell.values() if r["ok"])
    total = len(cell)
    print(f"\n=== {title} ===")
    print(f"cells: {total}  pass: {npass}  rate: {100*npass/total:.1f}%" if total else "no cells")
    # per scenario
    print("\nper-scenario:")
    for s in scen:
        c = [r for (sc,m),r in cell.items() if sc==s]
        p = sum(1 for r in c if r["ok"])
        print(f"  {s:<26} {p}/{len(c)}")
    print("\nper-model:")
    for m in models:
        c = [r for (sc,mm),r in cell.items() if mm==m]
        p = sum(1 for r in c if r["ok"])
        print(f"  {m:<28} {p}/{len(c)}")
    # matrix
    print("\nmatrix (scenario \\ model): P=pass . =fail")
    hdr = "".join(f"{m[:10]:>11}" for m in models)
    print(f"{'':<26}{hdr}")
    for s in scen:
        line = f"{s:<26}"
        for m in models:
            r = cell.get((s,m))
            line += f"{('P' if r and r['ok'] else ('.' if r else ' ')):>11}"
        print(line)
    return cell

def main():
    args = sys.argv[1:]
    if not args:
        evals_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        args = [os.path.join(evals_root, "runs", "sweep-baseline")]
    base = summarize(load(args[0]), f"SWEEP {args[0]}")
    if len(args) >= 2:
        after = summarize(load(args[1]), f"SWEEP {args[1]}")
        print("\n=== IMPROVEMENT (after vs base) ===")
        flips_up, flips_down = [], []
        for k in sorted(set(base)|set(after)):
            b = base.get(k); a = after.get(k)
            if b and a and not b["ok"] and a["ok"]:
                flips_up.append(k)
            if b and a and b["ok"] and not a["ok"]:
                flips_down.append(k)
        bp = sum(1 for r in base.values() if r["ok"]); bt=len(base)
        ap = sum(1 for r in after.values() if r["ok"]); at=len(after)
        print(f"base rate: {100*bp/bt:.1f}% ({bp}/{bt})  after rate: {100*ap/at:.1f}% ({ap}/{at})")
        print(f"newly PASSING: {len(flips_up)} -> {flips_up}")
        print(f"REGRESSED: {len(flips_down)} -> {flips_down}")

if __name__ == "__main__":
    main()
