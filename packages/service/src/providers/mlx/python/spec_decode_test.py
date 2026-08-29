"""Pure-stdlib suite for spec_decode's gates — the parts that decide when
speculation may run at all. The mlx-dependent halves (chunked prefill,
rounds) are covered by the live functional path and the eval gates; these
tests pin the refusal logic, which must be exactly right because every
refusal is silent-by-design (a logged degrade, not an error).

Run: python3 spec_decode_test.py  (no mlx required)
"""

import os
import sys
import types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import spec_decode  # noqa: E402


def _req(**kw):
    defaults = dict(temperature=None, repetition_penalty=None, top_k=None)
    defaults.update(kw)
    return types.SimpleNamespace(**defaults)


def test_eligibility():
    ok, why = spec_decode.eligibility(_req(), None)
    assert ok and why == "", (ok, why)
    ok, why = spec_decode.eligibility(_req(temperature=0.0), None)
    assert ok, why
    ok, why = spec_decode.eligibility(_req(temperature=0.7), None)
    assert not ok and "sampled" in why, why
    ok, why = spec_decode.eligibility(_req(), object())
    assert not ok and "processors" in why, why
    ok, why = spec_decode.eligibility(_req(repetition_penalty=1.1), None)
    assert not ok and "repetition_penalty" in why, why
    ok, why = spec_decode.eligibility(_req(top_k=40), None)
    assert not ok and "top_k" in why, why
    print("PASS eligibility")


def _args(draft="/nonexistent-drafter-dir"):
    return types.SimpleNamespace(
        spec_draft_model=draft, spec_draft_kind=None, spec_block_size=None
    )


def _logs():
    lines = []
    return lines, lines.append


def test_resolve_unconfigured_is_silent():
    lines, log = _logs()
    got = spec_decode.resolve_spec(
        types.SimpleNamespace(spec_draft_model=None), object(), None, log=log
    )
    assert got is None and lines == [], lines
    print("PASS resolve: unconfigured is silent")


def test_resolve_kill_switch():
    lines, log = _logs()
    os.environ["GEZEL_MLX_SPEC"] = "off"
    try:
        got = spec_decode.resolve_spec(_args(), object(), None, log=log)
    finally:
        del os.environ["GEZEL_MLX_SPEC"]
    assert got is None and any("GEZEL_MLX_SPEC=off" in l for l in lines), lines
    print("PASS resolve: kill switch")


def test_resolve_mlx_lm_tower_refused():
    lines, log = _logs()
    got = spec_decode.resolve_spec(_args(), object(), "mlx_lm", log=log)
    assert got is None and any("mlx_lm text tower" in l for l in lines), lines
    print("PASS resolve: mlx_lm tower refused")


def test_resolve_missing_drafter_dir():
    lines, log = _logs()
    got = spec_decode.resolve_spec(_args(), object(), None, log=log)
    assert got is None and any("drafter dir not found" in l for l in lines), lines
    print("PASS resolve: missing drafter dir")


def test_resolve_version_gate():
    """Below 0.6.17 (or unknown) the probe must refuse — 0.6.6's MTP
    verify is measured-inexact."""
    import importlib.metadata as md

    lines, log = _logs()
    here = os.path.dirname(os.path.abspath(__file__))
    real = md.version

    def fake_version(name):
        if name == "mlx-vlm":
            return "0.6.6"
        return real(name)

    md.version = fake_version
    try:
        got = spec_decode.resolve_spec(_args(draft=here), object(), None, log=log)
    finally:
        md.version = real
    assert got is None and any("inexact" in l for l in lines), lines

    # Unknown version (mlx-vlm absent, e.g. this bare-python3 run) also
    # refuses rather than guessing.
    lines2, log2 = _logs()
    got2 = spec_decode.resolve_spec(_args(draft=here), object(), None, log=log2)
    assert got2 is None and any(
        "inexact" in l or "cannot determine" in l for l in lines2
    ), lines2
    print("PASS resolve: version gate")


def test_cache_matches_tower():
    class KV:
        pass

    class Arrays:
        pass

    class Tower:
        def make_cache(self):
            return [Arrays(), KV()]

    t = Tower()
    assert spec_decode.cache_matches_tower([Arrays(), KV()], t)
    assert not spec_decode.cache_matches_tower([KV(), KV()], t)
    assert not spec_decode.cache_matches_tower([Arrays()], t)
    assert not spec_decode.cache_matches_tower(None, t)

    class Broken:
        def make_cache(self):
            raise RuntimeError("boom")

    assert not spec_decode.cache_matches_tower([Arrays()], Broken())
    print("PASS cache_matches_tower")


def test_clone_layers_roundtrip_and_isolation():
    class FakeLayer:
        def __init__(self, state, meta=""):
            self.state = state
            self.meta_state = meta

        @classmethod
        def from_state(cls, state, meta_state):
            return cls(list(state), meta_state)

    live = [FakeLayer([1, 2], "m1"), FakeLayer([3], "")]
    clones = spec_decode.clone_layers(live)
    assert [c.state for c in clones] == [[1, 2], [3]]
    assert [c.meta_state for c in clones] == ["m1", ""]
    live[0].state.append(99)
    assert clones[0].state == [1, 2], "clone must not alias the live list"
    print("PASS clone_layers")


def test_spec_mode():
    m, why = spec_decode.spec_mode(_req(), None)
    assert m == "greedy" and why == "", (m, why)
    m, _ = spec_decode.spec_mode(_req(temperature=0.7), None)
    assert m == "assisted", m
    m, _ = spec_decode.spec_mode(_req(), object())
    assert m == "assisted", m
    m, _ = spec_decode.spec_mode(_req(repetition_penalty=1.05), None)
    assert m == "assisted", m
    os.environ["GEZEL_MLX_SPEC"] = "greedy-only"
    try:
        m, why = spec_decode.spec_mode(_req(temperature=0.7), None)
        assert m is None and "greedy-only" in why, (m, why)
        m, why = spec_decode.spec_mode(_req(), object())
        assert m is None and "processor-armed" in why, (m, why)
        m, _ = spec_decode.spec_mode(_req(), None)
        assert m == "greedy", m
    finally:
        del os.environ["GEZEL_MLX_SPEC"]
    print("PASS spec_mode")


def main():
    test_eligibility()
    test_spec_mode()
    test_resolve_unconfigured_is_silent()
    test_resolve_kill_switch()
    test_resolve_mlx_lm_tower_refused()
    test_resolve_missing_drafter_dir()
    test_resolve_version_gate()
    test_cache_matches_tower()
    test_clone_layers_roundtrip_and_isolation()
    print("all spec_decode tests passed")


if __name__ == "__main__":
    main()
