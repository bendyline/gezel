# Developing @bendyline/gezel-script-runtime

Maintainer notes. This file is not published (`files` ships only `dist/`).

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
Run it after the SDK, core and script-runtime builds. See
[docs/mobile-plan.md](../../docs/mobile-plan.md) for the remaining mobile work.
