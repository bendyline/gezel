"""Pure-stdlib suite for wave_policy — the BatchEngine's scheduling
decisions. Every one of them is invisible from the outside (a wrong answer
reads as "the model is slow"), so they are pinned here.

Run: python3 wave_policy_test.py  (no mlx required)
"""

import os
import sys
import types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import wave_policy  # noqa: E402
from wave_policy import BACKGROUND, INTERACTIVE  # noqa: E402


def _sub(name, priority=INTERACTIVE, cancelled=False, cache_id="auto"):
    return types.SimpleNamespace(
        name=name,
        priority=priority,
        cancelled=cancelled,
        request=types.SimpleNamespace(cache_id=name if cache_id == "auto" else cache_id),
    )


def _names(subs):
    return [s.name for s in subs]


def test_normalize_priority():
    assert wave_policy.normalize_priority("background") == BACKGROUND
    assert wave_policy.normalize_priority(" Background ") == BACKGROUND
    assert wave_policy.normalize_priority("interactive") == INTERACTIVE
    # Absent and unknown values must never park a turn someone waits on.
    for value in (None, "", "bg", "low", 0, object()):
        assert wave_policy.normalize_priority(value) == INTERACTIVE, value
    # A sub without the attribute (older code paths) reads as interactive.
    assert not wave_policy.is_background(types.SimpleNamespace())
    print("PASS normalize_priority")


def test_select_wave_interactive_only_when_waiting():
    bg1, chat, bg2 = _sub("bg1", BACKGROUND), _sub("chat"), _sub("bg2", BACKGROUND)
    batch, rest = wave_policy.select_wave([bg1, chat, bg2], lambda n: n)
    assert _names(batch) == ["chat"], _names(batch)
    assert _names(rest) == ["bg1", "bg2"], _names(rest)
    print("PASS select_wave keeps background out of an interactive wave")


def test_select_wave_background_only_uses_capacity():
    subs = [_sub(f"bg{i}", BACKGROUND) for i in range(4)]
    batch, rest = wave_policy.select_wave(subs, lambda n: min(n, 3))
    assert _names(batch) == ["bg0", "bg1", "bg2"]
    assert _names(rest) == ["bg3"]
    print("PASS select_wave admits background in arrival order up to capacity")


def test_select_wave_memory_collapse():
    a, b = _sub("a"), _sub("b")
    batch, rest = wave_policy.select_wave([a, b], lambda n: 1)
    assert _names(batch) == ["a"] and _names(rest) == ["b"]
    batch, rest = wave_policy.select_wave([], lambda n: 1)
    assert batch == [] and rest == []
    print("PASS select_wave honors the admission count")


def test_preemptors():
    bg_running = [_sub("bg", BACKGROUND)]
    chat, gone, other_bg = _sub("chat"), _sub("gone", cancelled=True), _sub("x", BACKGROUND)
    assert _names(wave_policy.preemptors(bg_running, [other_bg, chat, gone])) == ["chat"]
    # A wave with any interactive member is never parked.
    mixed = [_sub("bg", BACKGROUND), _sub("person")]
    assert wave_policy.preemptors(mixed, [chat]) == []
    # Nothing running, or nobody interactive waiting: nothing to do.
    assert wave_policy.preemptors([], [chat]) == []
    assert wave_policy.preemptors(bg_running, [other_bg, gone]) == []
    print("PASS preemptors")


def test_cache_ids():
    subs = [_sub("a"), _sub("b"), _sub("a"), _sub("anon", cache_id=None)]
    assert wave_policy.cache_ids(subs) == ["a", "b"]
    print("PASS cache_ids dedupes and skips unroutable subs")


def test_marker_lines_match_the_ts_parser_shapes():
    assert (
        wave_policy.waiting_line("s1", 2, ["r1", "r2"])
        == "[batch] waiting cache=s1 ahead=2 behind=r1,r2"
    )
    assert wave_policy.waiting_line("s1", 0, []) == "[batch] waiting cache=s1 ahead=0 behind=-"
    assert wave_policy.paused_line("bg", ["chat"]) == "[batch] paused cache=bg for=chat"
    assert wave_policy.admitted_line("s1", 12.34) == "[batch] admitted cache=s1 waited=12.3s"
    assert wave_policy.admitted_line("s1", -1) == "[batch] admitted cache=s1 waited=0.0s"
    print("PASS marker lines")


def test_liveness_throttle():
    now = [100.0]
    throttle = wave_policy.LivenessThrottle(interval_s=8.0, clock=lambda: now[0])
    assert throttle.due("a")
    assert throttle.seen("a")
    assert not throttle.due("a")
    now[0] += 7.9
    assert not throttle.due("a")
    now[0] += 0.2
    assert throttle.due("a")
    assert throttle.due("b")  # independent keys
    throttle.forget("a")
    assert not throttle.seen("a")
    assert throttle.due("a")  # re-armed: immediate again
    throttle.forget(None)  # tolerated
    print("PASS liveness throttle")


def main():
    test_normalize_priority()
    test_select_wave_interactive_only_when_waiting()
    test_select_wave_background_only_uses_capacity()
    test_select_wave_memory_collapse()
    test_preemptors()
    test_cache_ids()
    test_marker_lines_match_the_ts_parser_shapes()
    test_liveness_throttle()
    print("all wave_policy tests passed")


if __name__ == "__main__":
    main()
