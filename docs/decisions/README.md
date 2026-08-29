# Architecture decisions

This directory records decisions whose rationale is easy to lose by reading
the implementation alone. Keep the small amount of personality in nearby code
comments; use a decision record to preserve the constraint, alternatives, and
regression surface when an anecdote is carrying architectural weight.

| Decision | Status | Subject |
| --- | --- | --- |
| [0001](0001-runtime-tool-inventory.md) | Accepted | Generate model tool instructions from the runtime tool surface |
| [0002](0002-onnxruntime-public-hoist.md) | Accepted | Publicly hoist `onnxruntime-*` packages under pnpm |
| [0003](0003-throughput-scaled-eval-ceilings.md) | Accepted | Scale eval hard ceilings by measured decode throughput |
| [0004](0004-accounts-and-project-acls.md) | Proposed | Accounts and per-project ACLs for shared machines |
| [0005](0005-indexing-3.0.md) | Accepted | Indexing 3.0: the `artifacts/shadow` tree, index provenance, whole-file reviews |
| [0006](0006-shared-library-project.md) | Accepted | The shared document library is a project (Documents becomes a facade) |
| [0007](0007-ambient-display-applier.md) | Accepted | Gezel is the wallpaper rotator, applied from Electron main |
| [0008](0008-per-task-artifact-folders.md) | Accepted | Per-task artifact folders (`tasks/<num>/`) over dedicated task-file tools |
| [0009](0009-observation-corpora.md) | Accepted | Observation corpora: tabular connector data, Parquet, and a local query engine |
