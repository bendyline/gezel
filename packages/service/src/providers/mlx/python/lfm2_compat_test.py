"""Unit tests for lfm2_compat (run with any python3 — no mlx needed).

No pytest harness is wired for the MLX python sidecar, so this is a
self-contained assert runner: it exits non-zero on failure.

    python3 lfm2_compat_test.py
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import lfm2_compat as lc  # noqa: E402

FAILURES: list[str] = []


def check(label: str, actual, expected) -> None:
    if actual != expected:
        FAILURES.append(f"{label}: expected {expected!r}, got {actual!r}")


def write_config(cfg) -> str:
    d = tempfile.mkdtemp()
    with open(Path(d) / "config.json", "w") as f:
        json.dump(cfg, f)
    return d


def read_config(d: str):
    with open(Path(d) / "config.json") as f:
        return json.load(f)


def test_backfills_from_intermediate_size() -> None:
    d = write_config({"model_type": "lfm2", "intermediate_size": 10752})
    check("returns written value", lc.ensure_lfm2_config_compat(d), 10752)
    check("wrote block_ff_dim", read_config(d)["block_ff_dim"], 10752)


def test_idempotent() -> None:
    d = write_config({"model_type": "lfm2", "intermediate_size": 10752})
    lc.ensure_lfm2_config_compat(d)
    check("second call is a no-op", lc.ensure_lfm2_config_compat(d), None)


def test_never_overwrites_existing() -> None:
    d = write_config(
        {"model_type": "lfm2", "intermediate_size": 10752, "block_ff_dim": 8192}
    )
    check("declines when present", lc.ensure_lfm2_config_compat(d), None)
    check("left value alone", read_config(d)["block_ff_dim"], 8192)


def test_ignores_other_architectures() -> None:
    d = write_config({"model_type": "qwen3", "intermediate_size": 10752})
    check("skips non-lfm2", lc.ensure_lfm2_config_compat(d), None)
    check("added nothing", "block_ff_dim" in read_config(d), False)


def test_tolerates_missing_and_malformed() -> None:
    check("missing dir", lc.ensure_lfm2_config_compat("/nonexistent/path"), None)
    d = tempfile.mkdtemp()
    with open(Path(d) / "config.json", "w") as f:
        f.write("{not json")
    check("malformed config", lc.ensure_lfm2_config_compat(d), None)
    d2 = write_config({"model_type": "lfm2"})
    check("no intermediate_size", lc.ensure_lfm2_config_compat(d2), None)
    d3 = write_config({"model_type": "lfm2", "intermediate_size": "10752"})
    check("non-int intermediate_size", lc.ensure_lfm2_config_compat(d3), None)


def main() -> int:
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    if FAILURES:
        for f in FAILURES:
            print(f"FAIL {f}")
        return 1
    print("lfm2_compat: all tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
