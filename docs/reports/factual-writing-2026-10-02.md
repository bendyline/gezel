# Factual writing: first measurement

2 October 2026. Gemma 4 31B (Q4, llama.cpp, Windows), one family-history
writer gezel with factual mode on against the same gezel with it off.

## Result

| | Factual mode on | Factual mode off |
|---|---|---|
| Real errors, hand-audited | **3 in 147 claims (2.0%)** | **7 in 137 claims (5.1%)** |
| Replies with a real error | **2 of 20** | **6 of 20** |
| Replies that looked something up | 20 of 20 | 14 of 20 |
| Expected key facts stated (judge) | 69% | 72% |
| Time per question, median / mean | 76 s / 121 s | 63 s / 85 s |

The writer in factual mode made fewer than half as many errors, and one of
its three is caught by a check added after the run (see below). It looked
something up for every question. The cost is about 15 seconds more per
answer at the median, and slightly fewer key facts stated: it leaves out
what it could not find rather than fill the gap.

## The errors

Factual mode on:

- "Mildred Washington: Born 1737" (she was born in 1739). Both the name and
  the year were in the cited source, but not together. The proximity check
  added afterwards requires a year to sit near the person it is attached to,
  and flags this.
- "Charles Washington: the youngest of the siblings" (Mildred was younger). A
  reasoning error with no checkable detail. The literal check cannot see it.
- Martha Parke Custis Peter called "Patsy". She was "Patty"; "Patsy" was her
  aunt. Same limit.

Factual mode off:

- Augustine and Mary Ball's "union in 1700". They married in 1731; Mary was
  born about 1708. This reply made no lookup at all.
- Betty born "c. 1735" (1733) and John Augustine born "c. 1739" (1736).
- Martha's "two children", twice. She had four; two survived infancy.
- Patsy "died at age 19" (17).
- Lawrence "passed away from pneumonia" (tuberculosis).

## What the run found and fixed

The first attempt was stopped after six questions because factual mode had a
hole. Asked to "write a paragraph about Martha Washington's children", the
writer saved the paragraph to a file and replied with one line naming it.
The file was from memory and had four wrong facts. Three fixes followed:

1. **Prose files are checked.** `write_file`, `write_artifact` and
   `write_document` of a `.md` or `.txt` file get the same check as a Word
   insert. They are refused when they state a name, date or number that no
   evidence shows. A cited file gets a `## Sources` list.
2. **"Write a…" keeps the lookups.** That request reads to the runtime as an
   immediate file write, which narrowed the turn to `write_file` alone. The
   writer had nothing to research with, so the prompt truthfully told it to
   ask the person for a source. Factual sessions now keep their lookup tools
   through every message-shaped clamp.
3. **A refusal names the next call.** Told only to "look it up", Gemma
   instead told the person it had no sources and asked for some. The refusal
   now names the session's lookup tools and the call to make.

After the fixes, the same question went: draft from memory, refused,
`wikipedia_search`, correct paragraph saved.

## Caveats

- One model, one topic, one run of 20 questions per arm. The gap is large
  enough to act on, not large enough to quote as a rate.
- The judge (the same Gemma, grading against a fixed answer key) is
  unreliable in both directions. It flagged six correct statements as
  wrong; four were "only one child survived to adulthood", which is true.
  It also called "union in 1700" unverified rather than wrong. Every number
  above is from reading the flags and the unverified claims by hand.
- In chat, factual mode annotates a reply; it does not block it. Only
  document inserts and saved prose files are refused. The Mildred error was
  in a chat reply and would now show under it as a statement no source
  supports.

## Reproduce

Arms in the Qualla dev home (`~/.gezel-qualla-dev`): gezel `ida-factual` in
project `fact-eval-factual`, and `ida-plain` in `fact-eval-plain`. Separate
projects matter: files one arm saves are indexed and would be injected into
the other's turns.

```
cd evals
.\node_modules\.bin\tsx.CMD src/bin/factuality.ts --home <home> --gezel ida-factual --project fact-eval-factual
.\node_modules\.bin\tsx.CMD src/bin/factuality.ts --home <home> --gezel ida-plain --project fact-eval-plain --judge-gezel ida-factual
```

Raw replies and grades: `evals/runs/factuality/2026-10-02T22-52-05-gemma31b-factual`
and `2026-10-02T23-35-42-gemma31b-plain` (git-ignored). The earlier
`2026-10-02T22-25-07` run is the stopped first attempt. The contract is [docs/factual-writing.md](../factual-writing.md).
