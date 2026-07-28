# @bendyline/gezel-script-stdlib

The standard gate-script library for [gezel](https://github.com/bendyline/gezel).

```bash
npm install @bendyline/gezel-script-stdlib
```

## What it ships

Plain `defineScript` TypeScript sources under `scripts/`, written against
[`@bendyline/gezel-sdk`](https://www.npmjs.com/package/@bendyline/gezel-sdk).
The daemon's script runner locates this package on disk and resolves these
sources **in place**, under scope `standard`.

Standard scripts are trusted: the runner executes them even when the security
policy disables user script execution. That is exactly why nothing outside this
package may ever masquerade as one — resolution only ever reads from this
package's own directory, and the module that does it exposes no write or delete
function.

The package is read-only by construction. It is published so that a Node-only
install of `@bendyline/gezel-service` gets the same standard library the
desktop app bundles.

## Stability

The supported surface is the **set of standard scripts and their check
semantics**, under semver. Removing a script or changing what it treats as a
pass is a breaking change.

MIT © Bendyline
