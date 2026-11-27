# Round 1 readout (interim, one trial per scenario)

Round 1 ran 2026-11-13 08:07 to 2026-11-16 08:12 (72 h), every cell on 9e5fd58f
with the same dist. Judged by claude-sonnet-5-5 at 08:12-08:24. 301 trials, 0
excluded for the wrong speculation mode, 0 wall-clock stops.

| Arm | Pass | Judged | Judge mean | Decode t/s | Draft acceptance |
| --- | --- | --- | --- | --- | --- |
| qwen3.8-27b-q4.none | 39/43 | 18 | 6.23 | 12.1 | - |
| qwen3.8-27b-q4.mtp | 40/43 | 19 | 6.42 | 28.9 | 63.6% |
| qwen3.8-27b-q4.dflash | 39/43 | 19 | 6.67 | 32.8 | 58.5% |
| gemma4-12b-q4.none | 31/43 | 19 | 4.65 | 28.7 | - |
| gemma4-12b-q4.mtp | 34/43 | 19 | 4.70 | 76.5 | 65.8% |
| muse-glimmer-30b-q4.none | 38/43 | 19 | 5.57 | 11.8 | - |
| muse-glimmer-30b-q4.dflash | 41/43 | 19 | 5.71 | 33.5 | 60.6% |

Paired by scenario, 95% bootstrap CI over scenarios:

| A vs B | Pass diff (pts) | Judge diff |
| --- | --- | --- |
| qwen mtp vs none | +2.3 [-9.3, 14.0] | +0.13 [-0.23, 0.48] |
| qwen dflash vs none | 0.0 [-11.6, 11.6] | +0.40 [0.06, 0.77] |
| qwen dflash vs mtp | -2.3 [-9.3, 4.7] | +0.26 [-0.02, 0.58] |
| gemma mtp vs none | +7.0 [-4.7, 18.6] | +0.05 [-0.34, 0.46] |
| muse dflash vs none | +7.0 [-2.3, 18.6] | +0.14 [-0.12, 0.43] |

Reading:

- One of ten intervals excludes zero (qwen dflash vs none, judge), which is
  what ten tests at 95% give by chance more often than not. It rests on
  refactor-module (+2.3) and deep-security-review (+1.4, where the `none` trial
  failed with a 2.5 KB report); without those two it is +0.22. Every point
  estimate that moves at all favors speculation, which rounds 2-3 will test.
- Decode-speed confound checked. The `none` arms' extra failures are mostly the
  craftbook `stale no-write repair loop` stop. Its time path (60 s unchanged,
  no in-flight turn younger than 4 min) could in principle punish slow decode,
  so every such stop was read: five came through escalation after 3-4
  byte-identical rewrites (count-driven); gemma none refactor-module stopped on
  its fifth plateau attempt during an identical rewrite; qwen none
  deep-security-review ended its turn after the second nudge without adding the
  missing section. None was cut off mid-generation. `chat-stalled` stops (two in
  each Gemma arm) are idle chats after a nudge, also speed-invariant.
