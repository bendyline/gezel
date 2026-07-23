# ADR 0002: Publicly hoist ONNX Runtime packages

- **Status:** Accepted
- **Decision owners:** workspace dependency layout and embedding runtime

## Context

`@huggingface/transformers` loads its Node entry point dynamically and resolves
`onnxruntime-common` as though it were visible beside `onnxruntime-node`.
pnpm's strict dependency layout can keep that transitive package out of the
resolution path even though installation succeeded.

The visible symptom is wider than vector memory: the same embedding pipeline
ranks craftbook suggestions. When it fails to load, suggestion ranking falls
back and can silently produce an empty shortlist, leaving kickoff tasks without
their expected craftbook gates.

## Decision

Keep `publicHoistPattern: ["*onnxruntime*"]` in the repository
`pnpm-workspace.yaml`. This is a narrow compatibility exception for the ONNX
package family, not a general request to flatten dependencies. A dependency
update may remove the need, but the pattern must not be deleted solely because
TypeScript or a bundled build succeeds.

## Consequences

The ONNX packages are visible from the workspace root, making the runtime's
dynamic resolution behavior match its expectation. This slightly weakens
pnpm's strict-layout isolation for one dependency family and must be rechecked
when `@huggingface/transformers` or `onnxruntime-node` changes.

## Verification and regression map

Run a clean `pnpm install` before testing; an existing `node_modules` can mask a
layout regression.

- [`packages/service/src/memory/embed-model.test.ts`](../../packages/service/src/memory/embed-model.test.ts)
  imports the real embedding module and therefore exercises dependency
  resolution before its kill-switch assertion.
- [`packages/service/src/craftbook/suggest.test.ts`](../../packages/service/src/craftbook/suggest.test.ts)
  protects semantic ranking and the embeddings-unavailable fallback, including
  the silent-empty shortlist failure mode.
