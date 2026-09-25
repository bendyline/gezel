# Requiring source reads in a craftbook

Use an `artifactReadEvidence` completion check when a reviewer must receive
every source before completing its task. A valid report alone does not establish
that the reviewer opened all of its inputs.

The workflow supplies a JSON array of exact artifact paths as a string parameter:

```json
{
  "readPaths": "[\"review/brief.json\",\"review/sources-1.json\",\"review/sources-2.json\"]"
}
```

Declare `readPaths` as a required string in the craftbook's parameter schema and
add this check alongside the report's existing validation:

```json
{
  "kind": "artifactReadEvidence",
  "paths": "{{readPaths}}"
}
```

The list is part of the instantiated task, not a manifest the reviewing model
can rewrite. An empty, duplicate, malformed or unresolved list fails closed.
The service checks successful tool receipts scoped to the current task and step.
Missing history, a skipped file or any uncovered line holds completion. Partial,
overlapping and out-of-order reads can combine into complete coverage; search
snippets and reads of different paths do not substitute. Truncated provider
deliveries do not generate read receipts.

Public tool records expose `deliveredResultTruncated` separately from
`resultTruncated`: the former describes the provider's context cap; the latter
describes the UI's bounded response summary. A complete UI response is not proof
that the provider received it. The MCP bridge records explicit true/false delivery
metadata for successful calls; absence on older records means unknown. Historical
`artifactReadSlices` remain the service's evidence of delivered line coverage.

For llama.cpp tool loops, the runtime makes room before adaptive output budgets
collapse to tiny slices. It first tries prior-turn compaction, then condenses
older tool observations while preserving the newest two and message pairing.
It also checks headroom against each actual MCP result, including multiple
calls returned in one model response. A result cannot be condensed before a
successful model request has carried it at least once; an oversized batch still
uses the ordinary output caps. An initial delivery cutoff carries a truncation
marker and asks for the missing content. Later shortening of an already presented
response uses a distinct context notice: it must not tell the model to restart
completed reads. The excerpt preserves a warning when the original response was
also truncated. This distinction does not prove comprehension or retention;
models can reopen specific source details needed for their current work.
Read receipts prove initial delivery, not continued retention. Craftbooks should avoid
loading duplicate evidence and keep individual reading assignments bounded.

Keep source paths and contents stable during the task. This gate checks exact
paths and line coverage, not content hashes, comprehension or source accuracy.
Use separately pinned input hashes and substantive review checks where needed.
The existing `corpusReadEvidence` gate uses the same coverage calculation for
records declared in a corpus batch manifest.

Both read checks support an evidence-only step with `outputMedium: "none"`
and an explicit read-tool allowlist. The service advances that step after its
required reads pass, even if the step does not expose `advance_task_step`.
Report-producing steps still use their usual completion procedure. A rejection
asks for missing reads rather than an unnecessary rewrite of the report.

A daemon must include this gate's core schema and service implementation before
accepting craftbooks that use it. Export matching Gilde schemas when shipping
the schema change; there is no installer requirement.
