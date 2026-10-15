# @bendyline/gezel-script-runtime

Portable, capability-mediated script execution for [Gezel](https://github.com/bendyline/gezel).

This package defines a platform-independent `ScriptExecutor` contract, a shared
portable runner, and a QuickJS-WASM executor that runs Gezel scripts against the
real Gezel SDK. Hosts that cannot use Node's sandbox — browsers and WebViews —
run the same bundled standard scripts, SDK and checks inside a dedicated Web
Worker. The Gezel service still selects its Node sandbox by default.

```bash
npm install @bendyline/gezel-script-runtime
```

Requires Node.js 24 or newer when used from Node.

| Import | What it provides |
|---|---|
| `@bendyline/gezel-script-runtime` | `PortableScriptRunner` and the `ScriptExecutor` contract |
| `@bendyline/gezel-script-runtime/quickjs` | `QuickJSScriptExecutor`, for use inside a dedicated worker |
| `@bendyline/gezel-script-runtime/web-worker` | `WebWorkerScriptExecutor`, the host side of a QuickJS Web Worker |
| `@bendyline/gezel-script-runtime/worker-protocol` | Message types and limits shared by host and worker |
| `@bendyline/gezel-script-runtime/compile` | `compilePortableScript`, the sandboxed TypeScript transpile step |
| `@bendyline/gezel-script-runtime/source` | Script diagnostics, craftbook script validation, and scaffolding |
| `@bendyline/gezel-script-runtime/meta` | `parseScriptMeta`, script metadata parsing |

## Host integration

The trusted host selects the executor. Scripts and model-generated metadata
cannot change it. On desktop, the service exports an adapter that places each
QuickJS guest in a dedicated worker:

```ts
import { QuickJSWorkerExecutor, ScriptRunner, Store } from '@bendyline/gezel-service';

const store = new Store({ home: '/path/to/gezel-home' });
await store.ensureLayout();

const runner = new ScriptRunner({
  store,
  executor: new QuickJSWorkerExecutor(),
  // Add chat, memory, tasks, … for the capabilities your scripts use.
});
```

Use the runner for product execution: it owns metadata/input validation,
the AI activity setting, capability dispatch, output validation, run history, and
secret redaction. The executor itself supplies none of those permissions.
Returning a successful VM result does not establish that a script has valid
product output. Construction above is intended for embedders and conformance
testing; there is no UI preference, API parameter, or automatic fallback that
selects it.

For another host, import `QuickJSScriptExecutor` from
`@bendyline/gezel-script-runtime/quickjs` inside a dedicated worker. Supply the
trusted SDK source as `sdkModuleSource`, a synchronous `compile` function, a
`now()` clock, and callbacks to the host's capability dispatcher. The SDK source
is the self-contained `portable` build that `@bendyline/gezel-sdk` ships; the
Gezel service reads the same file, `dist/portable.js`. Bundle it at build time
for a browser, or read it in Node:

```ts
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const sdkModuleSource = await readFile(
  fileURLToPath(import.meta.resolve('@bendyline/gezel-sdk/portable')),
  'utf8',
);
```

To let scripts import `@bendyline/gezel-sdk/checks` too, read that module the
same way and pass it as `modules: { '@bendyline/gezel-sdk/checks': source }`.
If the computer can sleep during a run, make `now()` leave out the time it spent
asleep, so a run is not timed out for time it could never use. The host must
also enforce a deadline and terminate the worker independently. The portable
executor uses standard host timers to pump promises; its guest receives no timer
or platform APIs.

The executor uses the `quickjs-emscripten` WASM package, so a WebView host needs
no native QuickJS bridge. A browser host can compile and validate the supported
subset of the standard library at build time. Project and user TypeScript
sources are compiled in a separate compiler worker that runs the TypeScript
browser compiler with Node hosts disabled; it only parses and transpiles.
Compiled programs execute in QuickJS, never in the compiler worker or the host's
JavaScript realm. Compilation has a 256,000-character source bound and a
host-enforced ten-second deadline. Only the bundled SDK and checks module can be
imported.

Source saves preserve invalid edits and return the shared metadata, syntax, and
runtime-compatibility diagnostics. Hash-based conflict detection is atomic.
Project/user scope is explicit, and edited code can never acquire the immutable
standard scope. Manual runs and task hooks/gates share the same capability,
policy and audit checks. Task note operations remain confined to the current
project and, for task-owned runs, the current task and active step.

Gates can hold advancement; approved transitions run ordinary exit hooks and
compare the persisted task with the snapshot they checked. A gate/exit child
retains its step trigger and records `parentRunId`, while inheriting the parent's
cancellation, remaining budget, and live policy ceiling. Trusted host callbacks
carry this authority; serialized SDK inputs cannot supply callbacks, bypass
gates, or force completion. Task-control calls are refused from lifecycle/gate
scripts to preserve their durable checkpoints. Creating a task from a script does
not start background model work. Craftbook sources are snapshotted verbatim with
the task, so later edits cannot change that run's recipe. Audits record scope,
source SHA-256 and template identity; craftbook provenance never grants
standard-library trust.

`PortableScriptRunner` takes a host resolver, dispatcher, configuration reader and
atomic run-record writer. It shares the desktop input/output validators, method
capabilities, metadata parser and execution-policy check. A host records admission
before any effect and stores the completed run using the ordinary
`projects/<id>/scripts/runs/<date>/<runId>.json` convention. Between the two,
progress snapshots are coalesced to one per `checkpointIntervalMs` (default 1 s);
a call's intent is written ahead of its effect when no snapshot is that recent.
Invalid output and failed audit writes cannot report success, and neither can a
gate that stamps no verdict. Any other script that declares `outputs` but never
calls `gezel.output()` finishes `ok` with no output and a warning in its log.
The runner stops a run that makes more than 250,000 host calls
(`DEFAULT_MAX_HOST_CALLS`, set with `limits.maxHostCalls`); it is a backstop
against runaway loops, sized for scripts that touch tens of thousands of
records. Standard-scope and provenance-trusted scripts have no call limit by
default (`limits.maxTrustedHostCalls`) and are bounded by their timeout. The
QuickJS executor has a separate, much smaller budget of its own: 1,000 host
calls and notifications per execution (its `maxCalls` option, and
`QUICKJS_MAX_CALLS` in the Web Worker host). Both apply, so a QuickJS run stops
at whichever it reaches first. Deadlines leave out time the computer spent
asleep. Canceling a run from the host takes effect even before its deadline,
and waits for host effects already under way and child audits to settle.

## Script profile (experimental)

Scripts import `gezel` and `defineScript` from `@bendyline/gezel-sdk` as usual.
The service adapter also bundles `@bendyline/gezel-sdk/checks`. Imports from the
filesystem/network and other SDK subpaths are rejected. No Node globals, raw
filesystem, raw networking, timers, subprocess APIs, or package resolver are
installed in the guest. SDK operations cross a JSON boundary into the normal
host dispatcher. `console` methods use the SDK's log notification.

**Await all asynchronous work at module level, then write output.** For example:

```ts
import { gezel } from '@bendyline/gezel-sdk';

const files = await gezel.artifacts.list();
gezel.output({ count: files.length });
```

The runtime rejects module completion with pending host calls and rejects output
while host calls are pending. Catching an awaited capability denial is supported,
including its typed `code`. Detached asynchronous functions and floating promises
are unsupported: the QuickJS binding does not expose an unhandled-rejection
tracker, so detached promise failures cannot reliably be reported. This is not
full Node script compatibility.

QuickJS executor defaults are 32 MiB guest heap, 512 KiB guest stack, 1,000 host
calls and notifications, 32 pending calls, one million UTF-16 code units per
source or message, and four million aggregate units. The service worker also bounds JSON traffic and has its
own V8 heap limits. These are separate bounds, not a total application memory
limit. An interrupted worker ignores late replies and the runner freezes its
audit record before redaction and persistence.

Termination stops guest execution and future calls. It cannot undo or cancel an
already-started host write or network request; the run records pending
operations as potentially still completing. Scripts must not treat a timeout as a
transaction rollback. Cancellation revokes new calls and waits for
already-dispatched file operations before releasing admission. A host that
closes mid-run marks unfinished records interrupted on reopen and never replays
them.

## Stability

The exports above are public API under semver. The package is new: the Gezel
service is its first host, and the executor contract may grow as other hosts
adopt it.

## Documentation

- [Repository and full documentation](https://github.com/bendyline/gezel)
- [Gezel SDK](https://www.npmjs.com/package/@bendyline/gezel-sdk)

MIT © Bendyline
