#!/usr/bin/env python3
"""Join a craftbook eval matrix into a pass grid + a diagnosis-ready failure worklist.

Usage:
  craftbook_matrix_report.py <runsDir> [<runsDir> ...]   # one or more matrix/batch dirs
  craftbook_matrix_report.py <dir> --md                  # emit Markdown tables (for the report)
  craftbook_matrix_report.py <dir> --failures-only       # skip the pass grid

Recursively reads <dir>/**/result.json, so it works for every layout the runner
writes: matrix (matrix-<ts>/<scenarioId>/<trialId>/), single batch (batch-<ts>/<trialId>/),
and flat single trials (runs/<trialId>/). Latest trial per (scenario, model) wins
(basename timestamp compare), matching sweep_report.py.

What it adds over sweep_report.py: it joins the harness `failureClass` / `failureClassRule`
/ `finalSniff.failReason` onto every failing cell and assigns a MECHANICAL first-pass
category — but ONLY for the classes the harness can decide on its own. Every `model`-class
failure is left as NEEDS-DIAGNOSIS on purpose: the four-way call (eval / craftbook /
model-capability) is a human judgement the $craftbook-eval-matrix skill makes by reading
the trial artifacts. This script never calls a failure "model capability"; that verdict
has to be earned, not defaulted.

first-pass category  <- failureClass / rule
  FRAMEWORK   <- infra + {daemon-crash, spawn-error, engine-hung, chat-template-500,
                          scheduler-voorman-deadlock, render-killed}   (runtime/harness bug)
  ENVIRONMENT <- infra + {capacity-denial, context-overflow}          (box/model can't fit;
                          context-overflow may ALSO mean a craftbook that over-feeds context)
  EVAL        <- grader                                               (grader was wrong)
  RERUN       <- operator                                            (interrupted; not a result)
  NEEDS-DIAGNOSIS <- model (the default bucket)                       (human four-way call)
"""
import os, sys, json, glob
from collections import defaultdict, Counter

# Gate detail strings carry ≥ / → and other non-latin1 glyphs; Windows consoles
# default to cp1252 and would crash on them. Force UTF-8 for our own output.
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

FRAMEWORK_RULES = {
    "daemon-crash", "spawn-error", "engine-hung",
    "chat-template-500", "scheduler-voorman-deadlock", "render-killed",
}
ENVIRONMENT_RULES = {"capacity-denial", "context-overflow"}


def category(row):
    if row["ok"]:
        return "PASS"
    fc = row["failureClass"]
    rule = row["failureClassRule"]
    if fc == "operator":
        return "RERUN"
    if fc == "grader":
        return "EVAL"
    if fc == "infra":
        if rule in FRAMEWORK_RULES:
            return "FRAMEWORK"
        if rule in ENVIRONMENT_RULES:
            return "ENVIRONMENT"
        return "FRAMEWORK"  # unknown infra rule: still a harness-side failure
    # fc == "model" (or missing on a failed trial) -> earn the four-way verdict
    return "NEEDS-DIAGNOSIS"


def load(d):
    rows = []
    for p in glob.glob(os.path.join(d, "**", "result.json"), recursive=True):
        try:
            r = json.load(open(p, encoding="utf-8"))
        except Exception:
            continue
        sniff = r.get("finalSniff") or {}
        rows.append({
            "scenario": r.get("scenarioId"),
            "model": r.get("modelId"),
            "tier": r.get("modelTier") or "?",
            "ok": bool(r.get("success")),
            "reason": (r.get("reason") or "").replace("\n", " ")[:120],
            "failureClass": r.get("failureClass") or ("pass" if r.get("success") else "model"),
            "failureClassRule": r.get("failureClassRule") or "",
            "failReason": (sniff.get("failReason") or "").replace("\n", " ")[:120],
            "sec": round((r.get("durationMs") or 0) / 1000),
            "trialdir": os.path.basename(os.path.dirname(p)),
            "runDir": os.path.dirname(p),
        })
    return rows


def latest_cells(rows):
    cell = {}
    for r in rows:
        k = (r["scenario"], r["model"])
        if k not in cell or r["trialdir"] > cell[k]["trialdir"]:
            cell[k] = r
    return cell


def report(cell, title, md=False, failures_only=False):
    scen = sorted({s for (s, _m) in cell})
    models = sorted({m for (_s, m) in cell})
    npass = sum(1 for r in cell.values() if r["ok"])
    total = len(cell) or 1
    fails = [r for r in cell.values() if not r["ok"]]
    cats = Counter(category(r) for r in fails)

    print(f"\n=== {title} ===")
    print(f"cells: {len(cell)}  pass: {npass}  fail: {len(fails)}  rate: {100 * npass / total:.1f}%")
    print("failure first-pass categories: " + (", ".join(f"{k}={v}" for k, v in cats.most_common()) or "none"))

    if not failures_only and len(models) > 1:
        print("\nmatrix (book \\ model): P=pass  .=fail  (blank=not run)")
        hdr = "".join(f"{m[:12]:>13}" for m in models)
        print(f"{'':<30}{hdr}")
        for s in scen:
            line = f"{s:<30}"
            for m in models:
                r = cell.get((s, m))
                line += f"{('P' if r and r['ok'] else ('.' if r else ' ')):>13}"
            print(line)

    # Failure worklist — the diagnosis input. Grouped by first-pass category so a
    # human works the certain buckets fast and spends real time on NEEDS-DIAGNOSIS.
    if fails:
        order = ["NEEDS-DIAGNOSIS", "FRAMEWORK", "EVAL", "ENVIRONMENT", "RERUN"]
        print("\nfailure worklist (open each runDir's daemon.log + sessions to diagnose):")
        for catname in order:
            group = sorted([r for r in fails if category(r) == catname],
                           key=lambda r: (r["scenario"], r["model"]))
            if not group:
                continue
            print(f"\n  [{catname}]  ({len(group)})")
            for r in group:
                detail = r["failReason"] or r["reason"]
                print(f"    {r['scenario']:<28} {r['model']:<18} {r['tier']:<7} "
                      f"{r['failureClass']}/{r['failureClassRule'] or '-'}  :: {detail}")
                print(f"        {r['runDir']}")

    if md:
        print("\n<!-- markdown -->")
        print(f"\n**{title}** — {npass}/{len(cell)} pass ({100 * npass / total:.1f}%). "
              + (", ".join(f"{k} {v}" for k, v in cats.most_common()) or "no failures"))
        print("\n| Book | Model | Tier | First-pass | failureClass/rule | Detail |")
        print("|---|---|---|---|---|---|")
        for r in sorted(fails, key=lambda r: (category(r), r["scenario"], r["model"])):
            detail = (r["failReason"] or r["reason"]).replace("|", "\\|")
            print(f"| {r['scenario']} | {r['model']} | {r['tier']} | {category(r)} | "
                  f"{r['failureClass']}/{r['failureClassRule'] or '-'} | {detail} |")


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    if not args:
        print(__doc__)
        sys.exit(2)
    for d in args:
        rows = load(d)
        if not rows:
            print(f"\n=== {d} ===\n(no result.json found under this dir)")
            continue
        report(latest_cells(rows), d, md="--md" in flags, failures_only="--failures-only" in flags)


if __name__ == "__main__":
    main()
