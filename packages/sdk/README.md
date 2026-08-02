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

## Entry points

| Subpath | Contents |
|---|---|
| `@bendyline/gezel-sdk` | `defineScript` and the script context types |
| `@bendyline/gezel-sdk/checks` | Reusable gate-check primitives |
| `@bendyline/gezel-sdk/stores` | Store interfaces for custom backends |

Scripts written against this SDK are resolved and executed in place by the
daemon's script runner. See
[`@bendyline/gezel-script-stdlib`](https://www.npmjs.com/package/@bendyline/gezel-script-stdlib)
for the standard library of gate scripts built on it.

## Stability

Public API under semver.

MIT © Bendyline
