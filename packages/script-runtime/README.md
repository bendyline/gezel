# Portable script runtime

The first mobile script execution increment: a platform-independent
`ScriptExecutor` contract and an experimental QuickJS-WASM implementation, tested
against the real Gezel SDK. The service still selects its Node sandbox by default.
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

The implementation uses the installed `quickjs-emscripten` WASM package. It does
not yet provide a Swift/JNI QuickJS bridge or claim to run on a mobile device.
Native QuickJS remains an alternative behind the same execution contract.

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
transaction rollback. Mobile hosts will need explicit cancellation and lifecycle
policies for their dispatcher operations.

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
