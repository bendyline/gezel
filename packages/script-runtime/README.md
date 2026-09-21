# Portable script runtime

A platform-independent `ScriptExecutor` contract, shared portable runner, and
QuickJS-WASM implementation tested against the real Gezel SDK. Mobile uses a
dedicated Web Worker with the same bundled standard scripts, SDK and checks as
desktop. The service still selects its Node sandbox by default.
See the [mobile plan](../../docs/mobile-plan.md) for the remaining application work.

## Host integration

The trusted host selects the executor. Scripts and model-generated metadata
cannot change it. On desktop, the service exports an adapter that places each
QuickJS guest in a dedicated worker:

```ts
import { ScriptRunner, QuickJSWorkerExecutor } from '@bendyline/gezel-service';

const runner = new ScriptRunner({
  store,
  chat,
  executor: new QuickJSWorkerExecutor(),
  // Supply other normal ScriptRunner dependencies for the capabilities in use.
});
```

Use the runner for product execution: it owns metadata/input validation,
engagement restrictions, capability dispatch, output validation, run history, and
secret redaction. The executor itself supplies none of those permissions.
Returning a successful VM result does not establish that a script has valid
product output. Construction above is intended for embedders and conformance
testing; there is no new UI preference, API parameter, or automatic fallback.

For another host, import `QuickJSScriptExecutor` from
`@bendyline/gezel-script-runtime/quickjs` inside a dedicated worker. Supply trusted
bundled SDK source, a synchronous compiler, an awake-time clock, and callbacks to
the host's capability dispatcher. The host must also enforce a deadline and
terminate the worker independently. The portable executor uses standard host
timers to pump promises; its guest receives no timer or platform APIs.

The implementation uses the installed `quickjs-emscripten` WASM package in the
mobile WebView worker. It does not require a Swift/JNI QuickJS bridge. Mobile
packages compile and validate a supported subset of the existing standard library
at build time. Project and user TypeScript sources use the ordinary shared editor
and source APIs. A separate compiler Worker runs the installed TypeScript browser
compiler with Node hosts disabled; it only parses and transpiles source. Compiled
programs execute in QuickJS, never in that compiler Worker or the app JavaScript
realm. Compilation has a 256,000-character source bound and a host-enforced
ten-second deadline. Only the bundled SDK and checks module can be imported.

Source saves preserve invalid edits and return the shared desktop metadata,
syntax, and runtime-compatibility diagnostics. Hash-based conflict detection is
atomic. Project/user scope is explicit, and edited code can never acquire the
immutable standard scope. Manual runs and task hooks/gates share the same
capability, policy and audit checks. Task note operations remain confined to the
current project and, for task-owned runs, the current task and active step.
Local task creation, editing, and advancement use the product task manager. Gates
can hold advancement; approved transitions run ordinary exit hooks and compare
the persisted task with the snapshot they checked. A gate/exit child retains its
step trigger and records `parentRunId`, while inheriting the parent's cancellation,
remaining budget, and live policy ceiling. Trusted host callbacks carry this
authority; serialized SDK inputs cannot supply callbacks, bypass gates, or force
completion. Task-control calls are refused from lifecycle/gate scripts to preserve
their durable checkpoints; task notes and authored auto-advance outputs remain
available. Creating a task from a script does not start background model work.
Craftbook sources are snapshotted verbatim with the task, with ordinary
provenance-marked copies installed in its project. A task resolves its embedded
copy before the installed library, so subsequent edits cannot change that run's
recipe. Audits record scope, source SHA-256 and template identity; craftbook
provenance never grants standard-library trust.

`PortableScriptRunner` takes a host resolver, dispatcher, configuration reader and
atomic run-record writer. It shares the desktop input/output validators, method
capabilities, metadata parser and execution-policy check. Mobile records admission
and each host-call intent before effects, then stores the completed run using the
ordinary `projects/<id>/scripts/runs/<date>/<runId>.json` convention. Missing output,
invalid output and failed audit writes cannot report success.
Long-running deadlines use the shared awake-time budget with scoped suspend
monitoring and disposed polling timers. Explicit host cancellation takes precedence
over sleep credit and waits for dispatched host effects and child audits to settle.

## Experimental script profile

Scripts import `gezel` and `defineScript` from `@bendyline/gezel-sdk` as before.
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
are unsupported: this QuickJS binding does not expose an unhandled-rejection
tracker, so arbitrary detached JavaScript promise failures cannot reliably be
reported. This is not full Node script compatibility; standard script conformance
and a stronger rejection policy must gate any wider rollout.

Defaults are 32 MiB guest heap, 512 KiB guest stack, 1,000 host calls/notifications,
32 pending calls, one million UTF-16 code units per source/message, and four
million aggregate units. The service worker also bounds JSON traffic and has its
own V8 heap limits. These are separate bounds, not a total application RSS limit.
The normal runner supplies its awake-time timeout. An interrupted worker ignores
late replies and the runner freezes its audit record before redaction/persistence.

Termination stops guest execution and future calls. It cannot undo or cancel an
already-started host write/network request; the run records pending operations
as potentially still completing. Scripts must not treat a timeout as a
transaction rollback. Mobile cancellation revokes new calls and waits for already-dispatched file
operations before releasing admission. Closing the app cancels the worker;
reopening marks unfinished records interrupted and never replays them. A worker
wall-time deadline includes suspension so stale work cannot silently resume.

## Verification

`src/quickjs.test.ts` executes the real WASM runtime and checks SDK calls,
capability errors, import/global isolation, deadlines, memory/call/traffic limits,
awaited completion, error bounds, cancellation, and disposal. Service integration
tests exercise real runner validation/permissions, artifact roundtrips, worker
termination, and late-callback audit stability. The existing Node executor tests
preserve desktop sandbox and transport behavior.

Run tests under the workspace dependency read lease using the root test command,
or the targeted service suites in `packages/service/src/scripts/`. Build the SDK
before this package and build this package before the service; the root build
already enforces that order.

The mobile browser contract harness (`packages/mobile/scripts/test-scripts.mjs`)
uses a real dedicated Web Worker and WASM, ordinary browser product files and the
portable runner. It checks standard gates, workspace writes, artifact
transformation, authored TypeScript compilation/execution, source conflicts and
reopen persistence, lifecycle hooks, task notes, completion gates, policy denial,
audit recovery, UI responsiveness, cancellation and absence of external requests.
Run it after the SDK, core and script-runtime builds.
