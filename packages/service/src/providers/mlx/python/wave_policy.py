"""Who the BatchEngine serves next, and when background work steps aside.

The engine runs static waves: a wave is admitted, prefilled, and decoded to
completion before the next one starts (mid-wave joins are not supported by
the mlx_vlm caches). Two consequences used to be invisible from the outside:

  - A request that arrives mid-wave waits for the whole wave — prefill AND
    generation — while the client only sees an HTTP 200 and silence. The TS
    watchdog then read the silence as a dead engine. Wild-caught: a person's
    300-token question waited behind a craftbook turn re-prefilling 55k
    tokens after a restart, was labelled "Processing prompt" for seven
    minutes, and died at the pre-first-byte watchdog without ever starting.
  - Nothing distinguished that person's turn from the background task it
    was stuck behind.

This module owns the decisions; the engine owns the mechanics (parking a
wave, swapping generators, printing). Pure stdlib so the decisions are
unit-tested without MLX — see wave_policy_test.py.

Markers printed by the engine (parsed by the TS stdout-parser, routed to the
owning session by `cache=`):

  [batch] waiting cache=<id> ahead=<n> behind=<id,id|->
      queued behind a running wave; liveness for the waiting request
  [batch] paused cache=<id> for=<id,id|->
      a parked background wave; liveness for its (silent) stream
  [batch] admitted cache=<id> waited=<seconds>
      a previously-waiting request has started
"""

from __future__ import annotations

import time
from typing import Callable, Dict, Iterable, List, Optional, Sequence, Tuple

INTERACTIVE = "interactive"
BACKGROUND = "background"

# Repeat cadence for waiting/paused liveness markers. The TS watchdogs it
# feeds are minutes long; this only has to be comfortably inside them while
# keeping a ten-request fanout from flooding the log.
LIVENESS_INTERVAL_S = 8.0


def normalize_priority(value: object) -> str:
    """Only an explicit "background" is background.

    Absent (an older daemon), misspelled, or None reads as interactive —
    the direction that never parks a turn somebody is waiting on."""
    if isinstance(value, str) and value.strip().lower() == BACKGROUND:
        return BACKGROUND
    return INTERACTIVE


def is_background(sub: object) -> bool:
    return getattr(sub, "priority", INTERACTIVE) == BACKGROUND


def is_live(sub: object) -> bool:
    return not getattr(sub, "cancelled", False)


def select_wave(
    pending: Sequence[object], admit_count: Callable[[int], int]
) -> Tuple[List[object], List[object]]:
    """Pick this wave's members from `pending` (arrival order).

    When anyone interactive is waiting the wave is interactive-only. A
    batched wave prefills every member before any of them decodes, so a
    co-admitted background turn would put its whole prefill inside the
    person's time-to-first-token. Returns (batch, rest); `rest` keeps
    arrival order."""
    candidates = [s for s in pending if not is_background(s)] or list(pending)
    n = int(admit_count(len(candidates))) if candidates else 0
    batch = candidates[: max(0, min(len(candidates), n))]
    chosen = {id(s) for s in batch}
    rest = [s for s in pending if id(s) not in chosen]
    return batch, rest


def preemptors(running: Iterable[object], pending: Sequence[object]) -> List[object]:
    """Interactive requests that should run ahead of the running wave.

    Only a wave made entirely of background work steps aside: an
    interactive member means a person is already being served, and parking
    them for another person just moves the wait around."""
    members = list(running)
    if not members or not all(is_background(s) for s in members):
        return []
    return [s for s in pending if is_live(s) and not is_background(s)]


def cache_ids(subs: Iterable[object]) -> List[str]:
    """Routable ids of `subs`, de-duplicated in order. A sub with no
    cache_id cannot be addressed by the TS side, so it is left out."""
    out: List[str] = []
    for s in subs:
        cid = getattr(getattr(s, "request", None), "cache_id", None)
        if cid and cid not in out:
            out.append(str(cid))
    return out


def _ids_field(ids: Sequence[str]) -> str:
    return ",".join(ids) if ids else "-"


def waiting_line(cache_id: str, ahead: int, behind: Sequence[str]) -> str:
    return f"[batch] waiting cache={cache_id} ahead={int(ahead)} behind={_ids_field(behind)}"


def paused_line(cache_id: str, for_ids: Sequence[str]) -> str:
    return f"[batch] paused cache={cache_id} for={_ids_field(for_ids)}"


def admitted_line(cache_id: str, waited_s: float) -> str:
    return f"[batch] admitted cache={cache_id} waited={max(0.0, waited_s):.1f}s"


class LivenessThrottle:
    """Per-key emission gate: the first marker for a key goes out at once,
    repeats at most every `interval_s`. `forget` re-arms a key so a request
    that waits a second time announces itself immediately."""

    def __init__(
        self,
        interval_s: float = LIVENESS_INTERVAL_S,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.interval_s = float(interval_s)
        self._clock = clock
        self._last: Dict[str, float] = {}

    def due(self, key: str) -> bool:
        now = self._clock()
        last = self._last.get(key)
        if last is not None and now - last < self.interval_s:
            return False
        self._last[key] = now
        return True

    def seen(self, key: str) -> bool:
        return key in self._last

    def forget(self, key: Optional[str]) -> None:
        if key:
            self._last.pop(key, None)
