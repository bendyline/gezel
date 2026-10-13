#!/usr/bin/env python3
"""Stdlib-only tests for qwen4_ple.py. Run directly."""

import json
import os
import tempfile
from pathlib import Path

import qwen4_ple


def _checkpoint(root: Path, model_type="qwen4_exp") -> Path:
    source = root / "source"
    source.mkdir()
    (source / "config.json").write_text(
        json.dumps({"model_type": model_type, "text_config": {"model_type": "qwen4_exp_text"}})
    )
    (source / "model.safetensors.index.json").write_text(
        json.dumps(
            {
                "weight_map": {
                    "language_model.model.layers.1.ple.ple_embedding.ngram_embedding.shards.0.weight": "model.safetensors",
                    "language_model.model.embed_tokens.weight": "model.safetensors",
                }
            }
        )
    )
    (source / "model.safetensors").write_bytes(b"weights")
    return source


def _fake_prepare(source: Path, target: Path, *, cache_rows: int):
    assert cache_rows == 0
    target.mkdir(parents=True)
    os.link(source / "model.safetensors", target / "model.safetensors")
    (target / "config.json").write_text(
        json.dumps(
            {
                "model_type": "qwen4_exp",
                "text_config": {"ple_storage": {"manifest": "ple-store.json"}},
            }
        )
    )
    (target / "ple-store.json").write_text("{}")


def test_prepare_reuse_and_invalidate():
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        source = _checkpoint(root)
        target = root / "views" / "qwen4-ple"
        stale = target.parent / ".qwen4-ple.123.interrupted.partial"
        stale.mkdir(parents=True)
        (stale / "linked-shard").write_bytes(b"stale")
        calls = []

        def prepare(*args, **kwargs):
            calls.append(1)
            _fake_prepare(*args, **kwargs)

        effective, status, applicable = qwen4_ple.prepare_external_ple_view(
            str(source), str(target), prepare_fn=prepare
        )
        resolved_target = str(target.resolve())
        assert (effective, status) == (resolved_target, "prepared"), (effective, status)
        assert applicable
        assert not stale.exists()
        assert os.stat(source / "model.safetensors").st_ino == os.stat(
            target / "model.safetensors"
        ).st_ino

        effective, status, applicable = qwen4_ple.prepare_external_ple_view(
            str(source), str(target), prepare_fn=prepare
        )
        assert (effective, status) == (resolved_target, "reused"), (effective, status)
        assert applicable
        assert len(calls) == 1

        # A changed source index invalidates and atomically rebuilds the view.
        index = json.loads((source / "model.safetensors.index.json").read_text())
        index["metadata"] = {"revision": "next"}
        (source / "model.safetensors.index.json").write_text(json.dumps(index))
        effective, status, applicable = qwen4_ple.prepare_external_ple_view(
            str(source), str(target), prepare_fn=prepare
        )
        assert (effective, status) == (resolved_target, "prepared"), (effective, status)
        assert applicable
        assert len(calls) == 2
    print("PASS qwen4 PLE prepare/reuse/invalidate")


def test_non_qwen_falls_back_without_preparing():
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        source = _checkpoint(root, model_type="gemma4")
        config = json.loads((source / "config.json").read_text())
        config["text_config"]["model_type"] = "gemma4_text"
        (source / "config.json").write_text(json.dumps(config))
        called = []
        effective, status, applicable = qwen4_ple.prepare_external_ple_view(
            str(source), str(root / "view"), prepare_fn=lambda *a, **k: called.append(1)
        )
        assert effective == str(source.resolve())
        assert status == "not a quantized Qwen4 PLE checkpoint"
        assert not applicable
        assert not called
    print("PASS qwen4 PLE non-applicable fallback")


def test_applicable_failure_is_classified_for_strict_launcher():
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        source = _checkpoint(root)

        def fail_prepare(*_args, **_kwargs):
            raise RuntimeError("synthetic prepare failure")

        effective, status, applicable = qwen4_ple.prepare_external_ple_view(
            str(source), str(root / "view"), prepare_fn=fail_prepare
        )
        assert effective == str(source.resolve())
        assert "synthetic prepare failure" in status
        assert applicable
    print("PASS qwen4 PLE applicable failure classification")


if __name__ == "__main__":
    test_prepare_reuse_and_invalidate()
    test_non_qwen_falls_back_without_preparing()
    test_applicable_failure_is_classified_for_strict_launcher()
