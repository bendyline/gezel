# 0008 — Per-task artifact folders

Status: Accepted (2026-08)

## Context

Craftbooks told models where to store working files with ad-hoc artifact
paths, and those paths collided badly: at the time of this decision, 148 of
289 gilde craftbook templates wrote the literal same `notes/scope.md`, 47
wrote `report.md`, and two runs of the same book — even two concurrent tasks
in one project — overwrote each other's working material. Exactly one book
(powerpoint-deck 1.7.2+) had invented its own per-task namespace: a
`workPath` param defaulting to `powerpoint/task-{{task.num}}`.

An early product intent — every task has one folder that "lives with the
task" — had never been made a platform convention.

The design question with teeth was tool surface: models already juggle two
CRUD sets (workspace vs artifacts). Should per-task storage be a third —
`write_task_file("outline.md")` resolving against the task folder — or a
path convention over the existing artifact tools?

## Decision

`tasks/<num>/` inside the project's artifacts drawer is the per-task working
folder, addressed through the **existing artifact CRUD tools** — no new
tools.

- **The runtime, not the model, resolves the path.** `TaskManager.create`
  exposes a reserved `{{task.dir}}` interpolation token (= `tasks/<num>`)
  alongside `{{task.num}}`/`{{task.ref}}`/`{{task.projectId}}`; craftbook
  prompts and gates therefore carry fully-resolved literals
  (`write_artifact("tasks/11/outline.md")`) and the model never reasons
  about the convention. Late-added steps (`add_task_step`,
  `set_step_deliverable` patches) get the same interpolation, so an
  unresolved `{{task.dir}}` can no longer reach the step-gate's
  infrastructure-error guard.
- **The folder is stamped and ensured at create.** `Task.artifactDir`
  persists the folder; `create()` best-effort pre-creates it (writes
  mkdir -p on their own, so failure never blocks).
- **Fanout children inherit the host's folder.** The host's collect-barrier
  gates are interpolated with the host's number at host-create; per-child
  folders would leave them watching an empty directory. Shards are one
  task's work, already namespaced per-child by variation context
  (`{{batchNumber}}`, …).
- **Ad-hoc sessions are told the folder.** The injected task-context block
  names `tasks/<num>/` (roster-gated on `write_artifact` per ADR 0001).
- **Guards learned the prefix in lockstep.** `tasks/` joined
  `ARTIFACT_SCRIPT_PREFIXES` (a `tasks/11/report.html` is working material,
  not workspace source), `ACCESSORY_ARTIFACT_PREFIXES` (with the templated
  forms `{{task.dir}}/…` and `{{workPath}}/…`), the tool descriptions, and
  the system-prompt conventions line.
- **Gilde books migrate to a `workPath` param defaulting to
  `{{task.dir}}`** — the powerpoint precedent — rather than raw literals,
  because eval sidecars pin params (`workPath: "tasks/eval"`) to keep
  deliverable assertions deterministic. The gilde validator's accessory
  predicate resolves param defaults so `{{workPath}}/scope.md` keeps the
  artifact-drawer discipline. `code-review` is deliberately not migrated:
  its `reviews/<reviewId>/` paths are keyed by durable review records.

## Alternatives rejected

- **Dedicated task-file CRUD tools** (`write_task_file` et al.): most
  direct per call, but duplicates ~8 tools on a roster whose size
  measurably costs attention on small local models, gives every file two
  names (gates and craftbook content still speak artifact paths), and only
  meaningfully helps ad-hoc sessions — which one prompt line covers.
- **`<craftbook>/task-<num>/`** (the powerpoint layout): groups by activity
  instead of by task, leaves ad-hoc tasks with no home, and creates one
  top-level drawer folder per craftbook.

## Consequences

- `deleteProjectArtifact` stays unguarded for `tasks/`: the folder is
  garbage-collectible working material and users pruning old task folders
  is desired.
- Old colliding files written by pre-migration tasks coexist untouched —
  deleting user artifacts is worse than clutter.
- The UI file browser sorts `tasks/10` before `tasks/2`; numeric sort and
  a task-title label are follow-up UI work.
