---
id: writing-scripts-with-gezel-sdk
title: Writing scripts with gezel-sdk
order: 8
summary: Build typed, capability-limited automations that run inside a Gezel project.
---

# Writing scripts with gezel-sdk

A Gezel script is a small TypeScript automation that runs in a sandbox. It can inspect a project, create an artifact, update a task, ask a model a focused question, call an approved tool, or decide whether a craftbook step may advance. The `@bendyline/gezel-sdk` package is the typed bridge between that script and Gezel.

Scripts are project-scoped by default and live as readable files under `~/.gezel/projects/{projectId}/scripts/`. They can be run manually, attached to the start or end of a task step, used as a completion gate, or called by another script.

## Start in the app

Turn on **Settings → About → Advanced → Show advanced features**, then open **Scripts** from the sidebar. Choose a project and select **New script**. You can describe the automation for an AI draft, start from a working template, or begin with the blank skeleton.

The built-in editor supplies autocomplete for the exact SDK version used by the running daemon. Saving checks the metadata, TypeScript syntax, and Node-compatible type syntax; **Run** supplies a form for the inputs declared by the script and shows its output, logs, calls, and errors.

You do not need to install the SDK into each Gezel project. The daemon places its matching SDK in the sandbox at run time. Install `@bendyline/gezel-sdk` in a separate source repository only when that repository authors reusable scripts and should type-check them itself:

```bash
npm install --save-dev @bendyline/gezel-sdk
```

## The shape of a script

Every script exports a static `meta` block, reads validated input from `gezel.input`, and stamps one final result with `gezel.output()`. This gate checks that a workspace contains a README before a task step can finish:

```ts
import {
  defineScript,
  gezel,
  type GateScriptResult,
  type InferredInput,
} from '@bendyline/gezel-sdk';

export const meta = defineScript({
  name: 'require-readme',
  description: 'Require a README before this step can finish.',
  kind: 'gate',
  inputs: {
    path: {
      type: 'string',
      description: 'Workspace-relative README path.',
      default: 'README.md',
    },
  },
  requires: ['workspace.read'],
} as const);

const input = gezel.input as InferredInput<typeof meta>;
const files = await gezel.fs.listAll();

const result: GateScriptResult = files.includes(input.path)
  ? { decision: 'approve', message: `${input.path} is present.` }
  : {
      decision: 'reject',
      message: `Add ${input.path} with setup and usage instructions, then try again.`,
    };

gezel.output(result);
```

The file name is the script's invocation name, so keep it aligned with `meta.name`. Input descriptors drive the manual-run form and `InferredInput`; output descriptors document an action script's result. A gate instead returns `approve` or `reject`. A rejection must include a useful `message` because Gezel gives it directly to the working gezel as the repair instruction.

## Declare capabilities before using them

The `requires` list is both documentation and an enforced permission boundary. A call fails with `CAPABILITY_DENIED` when the matching capability was not declared, and project or installation policy can still deny a declared capability.

| Capability | SDK surface |
| --- | --- |
| `workspace.read`, `workspace.write` | `gezel.fs` for project workspace files |
| `artifacts.read`, `artifacts.write` | `gezel.artifacts` for generated project outputs |
| `documents.read`, `documents.write` | `gezel.documents` for the shared document library |
| `tasks.read`, `tasks.write` | `gezel.task` for task records, steps, and notes |
| `memory.read`, `memory.write` | `gezel.memory` for project memories |
| `llm` | `gezel.llm.oneShot()` |
| `network` | `gezel.mcp.call()` and `gezel.http` |
| `credential:<name>` plus `network` | `gezel.http.authed()` with a project-approved named credential |

`gezel.input`, `gezel.output()`, `gezel.log()`, and `gezel.script.run()` need no capability. A nested script runs under its own metadata and permission set, and nesting is limited to four levels.

Ask only for what the script needs. In particular, use `gezel.fs` for workspace I/O rather than importing Node's `fs`: raw filesystem code runs in an isolated scratch directory and cannot see the project workspace. For authenticated HTTP, the service attaches the named credential and scrubs it from the response; the secret value never enters the script.

## Actions, gates, and hooks

An action script produces ordinary structured output. Declare `outputs` in `meta`, then call `gezel.output()` exactly once with that shape. Actions are useful for reports, task updates, model-assisted transforms, and small integrations.

A gate script sets `kind: 'gate'` and returns a `GateScriptResult`. `approve` allows the step to complete. `reject` holds the step and explains what must change. Optional `goto` routing can send work back to an earlier step, while an approved `handoff` can pass a message and parameters to the next step.

After a script works manually, attach it from a task's step automation controls. Craftbooks can also ship scripts and connect them to step entry, exit, and gate moments. Gezel preserves a trace for each run: input, stamped output, logs, host calls, duration, trigger, and any error.

## Reusable helpers

The package has three public entry points:

| Import | Purpose |
| --- | --- |
| `@bendyline/gezel-sdk` | `defineScript`, `gezel`, metadata types, inferred input/output types, and gate result types |
| `@bendyline/gezel-sdk/checks` | Reusable gate-check predicates, `gateResult()`, and `workspaceFromGezel()` for adapting `gezel.fs` to check helpers |
| `@bendyline/gezel-sdk/stores` | File-backed `logStore`, `rosterStore`, and integer-cents `ledgerStore` helpers for scripts that maintain structured project state |

The separate `@bendyline/gezel-script-stdlib` package contains Gezel's trusted standard gate scripts. Use those by their `standard` scope when they already express the check you need; write a project script when the behavior belongs to one project, and a reusable craftbook script when it belongs to a workflow others will install.

If the code lives in another application rather than inside Gezel's sandbox, use [gezel-app-sdk](building-connected-apps-with-gezel-app-sdk.md) instead.
