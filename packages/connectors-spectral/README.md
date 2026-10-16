# @bendyline/gezel-connectors-spectral

Runs Apache-2.0 [Prismatic](https://github.com/prismatic-io/components)
connector actions for [Gezel](https://github.com/bendyline/gezel), in a process
of their own.

```bash
npm install @bendyline/gezel-connectors-spectral
```

## What it is for

Gezel uses these actions to read data from outside services into a project
through its connectors. The Gezel service never imports this package: it
**starts** the `run-action` entry point as a separate, sandboxed process, with
network access but no access to the project's files. That isolation is the
point: the pinned `@prismatic-io/spectral` SDK and the vendored components
never run inside the service.

A host launches it like this. The job, including the connection and any
secret it carries, goes in on stdin, never in arguments or environment
variables; the result comes back as one line of JSON on stdout:

```ts
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const entry = require.resolve('@bendyline/gezel-connectors-spectral/run-action');

const job = {
  component: 'echo',
  action: 'list',
  connectionInput: 'connection',
  connection: null,
  inputs: { records: [{ id: '1', title: 'hello' }] },
};

const child = execFile(process.execPath, [entry], (error, stdout, stderr) => {
  if (error) throw new Error(stderr || error.message);
  const { data } = JSON.parse(stdout);
  console.log(data);
});
child.stdin?.end(JSON.stringify(job));
```

On success the runner prints `{ "data": … }` and exits 0; on failure it writes
the message to stderr and exits 1. In production, run it inside your own
sandbox with a timeout. The vendored actions are listed, keyed
`<component>/<action>`, in the `VENDORED` registry this package exports.

## Entry points

| Subpath | Contents |
|---|---|
| `@bendyline/gezel-connectors-spectral` | The `VENDORED` action registry and the helpers the runner uses |
| `@bendyline/gezel-connectors-spectral/run-action` | The action runner a host starts as its own process |

## No type declarations

This package deliberately ships no `.d.ts`. Nothing type-imports it, and
declaration emit would have to name types out of the vendored components'
transitive `axios`, which is not portable. If you need types for a connector
action, model it against the connector schemas in `@bendyline/gezel/schemas`.

## Stability

The supported surface is the `run-action` **subprocess contract** — its
argument shape and its output envelope — under semver. The CommonJS module
exports are an implementation detail of that host.

## Third-party code and licenses

The compiled entry points contain a modified, minimal slice of Prismatic's
[open-source components](https://github.com/prismatic-io/components), licensed
under Apache-2.0. The package includes:

- [`NOTICE.md`](https://github.com/bendyline/gezel/blob/main/packages/connectors-spectral/NOTICE.md), which identifies the upstream component and the
  modifications made for Gezel;
- [`vendor/provenance.json`](https://github.com/bendyline/gezel/blob/main/packages/connectors-spectral/vendor/provenance.json), the machine-readable
  per-action source, license, runtime-version, modification, and content-hash
  ledger;
- [`THIRD_PARTY_LICENSES/Apache-2.0.txt`](https://github.com/bendyline/gezel/blob/main/packages/connectors-spectral/THIRD_PARTY_LICENSES/Apache-2.0.txt),
  the full upstream license text.

The package as a whole remains MIT-licensed by Bendyline; those vendored
portions remain under Apache-2.0.

MIT © Bendyline
