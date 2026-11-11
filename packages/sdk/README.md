# @bendyline/gezel-sdk

The extension surface for [gezel](https://github.com/bendyline/gezel) — typed
entry points for writing gate scripts, checks and custom stores.

This is the preferred surface for new integrations.
[`@bendyline/gezel-plugin-sdk`](https://www.npmjs.com/package/@bendyline/gezel-plugin-sdk)
is the historical equivalent, kept for compatibility.

```bash
npm install @bendyline/gezel-sdk
```

```ts
import { defineScript, gezel } from '@bendyline/gezel-sdk';

export const meta = defineScript({
  name: 'has-tests',
  description: 'Require at least one test file.',
  kind: 'gate',
  outputs: {
    decision: { type: 'string', description: "'approve' or 'reject'." },
  },
  requires: ['workspace.read'],
} as const);

const files = await gezel.fs.listAll();
gezel.output({
  decision: files.some((file) => file.includes('.test.')) ? 'approve' : 'reject',
});
```

## Running a script

Save the script as `~/.gezel/projects/<projectId>/scripts/has-tests.ts`, or
create it under **Scripts** in the Gezel app. The daemon then runs it on
demand, as a craftbook step's hook, or as a completion gate.
[Writing scripts with gezel-sdk](https://gezel.com/docs/writing-scripts-with-gezel-sdk/)
covers inputs, capabilities and gates.

The daemon's default executor is a Node sandbox that starts a script only inside
the operating system's own sandbox: Seatbelt on macOS, a systemd or helper
sandbox on Linux, and Microsoft's container launcher (MXC) on Windows. The
desktop app installs the Windows launcher; a daemon installed from npm downloads
it on first start when its security level allows app network traffic. Without
one, the daemon refuses to start a script rather than run it unconfined, with
`denyNet requires an enforceable OS network boundary`. To run scripts in your
own process instead, use the QuickJS executor from
[`@bendyline/gezel-script-runtime`](https://www.npmjs.com/package/@bendyline/gezel-script-runtime),
which needs no operating-system sandbox.

## Entry points

| Subpath | Contents |
|---|---|
| `@bendyline/gezel-sdk` | Node sandbox's `gezel` context, `defineScript`, and script context types |
| `@bendyline/gezel-sdk/portable` | `createGezelSDK`, `defineScript`, and platform-independent context/transport types |
| `@bendyline/gezel-sdk/checks` | Reusable gate-check primitives |
| `@bendyline/gezel-sdk/stores` | Store interfaces for custom backends |

Scripts written against this SDK are resolved and executed in place by the
daemon's script runner. See
[`@bendyline/gezel-script-stdlib`](https://www.npmjs.com/package/@bendyline/gezel-script-stdlib)
for the standard library of gate scripts built on it.

## Embedded runtimes

Hosts without Node can create a context for each script run through the portable
entry. It has no Node imports, stdin reads, global singleton, or platform globals:

```ts
import { createGezelSDK, type ScriptTransport } from '@bendyline/gezel-sdk/portable';

function createScriptContext(transport: ScriptTransport) {
  return createGezelSDK(transport);
}
```

The host supplies `transport.init` before executing the script, forwards
`call(method, params)` through its permission-checked dispatcher, and delivers
`notify(method, params)` synchronously. Outstanding calls must reject when the
run is cancelled or disposed. Each context permits one `gezel.output()` stamp.
An optional `log` callback mirrors log messages to a runtime-specific sink;
`script.log` notifications are always sent through the transport.

This boundary supplies the SDK API to an embedded interpreter; the host remains
responsible for isolation, memory and time limits, capability checks, and the
interpreter's asynchronous job loop. Existing desktop scripts keep importing
`gezel` from the default entry, which retains stdin initialization, fd-3 RPC,
and stderr logging.

## Stability

Public API under semver.

MIT © Bendyline
