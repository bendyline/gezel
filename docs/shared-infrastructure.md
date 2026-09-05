# Shared infrastructure ownership

Four formerly copied areas now have common owners with small adapters.

| Mechanics | Owner | Decisions that remain local |
| --- | --- | --- |
| Lazy provider construction, reset, drain, retirement, shutdown retry | [ProviderLifecycle](../packages/service/src/providers/provider-lifecycle.ts), using [ProviderRetirementGate](../packages/service/src/providers/retirement-gate.ts) | Each media manager selects native, cloud, mock, or remote routing and declares the operations that hold its engine. |
| Node TLS, HTTP/2, long-request timeout policy, dispatcher cleanup | [client Node transport](../packages/client/src/node-tls.ts) | Callers supply the certificate and semantic deadline. App SDK exports delegate to this implementation. Browser entries do not import it. |
| Model inventory, fitness polling, install/retry/cancel, deletion | [model controller](../packages/ui/src/components/use-local-model-manager.ts) and [install controller](../packages/ui/src/components/use-model-installs.ts) | [Engine adapters](../packages/ui/src/components/model-management-adapters.ts) select endpoints and normalize progress. Panels retain model fit, vision/context capabilities, catalog filters, and presentation. |
| Document encoding, MIME mapping, listing, primary-document selection | [content container](../packages/ui/src/components/SquisqIntegration/content-container.ts) | Artifact, workspace, and shared-library adapters bind separate client endpoints. Workspace raw writes still pass through workspace authority. |

Provider reset and retirement close operation admission before waiting for an
in-flight build and active work. A failed build remains an error for its caller
but cannot prevent retirement. A failed shutdown retains the provider for retry.
Reset permits a new generation; broker retirement prevents another native build.
A cloud provider remains user-owned and can still be selected after native
retirement. Existing handles cannot restart work after their generation closes.

The Node fetch helpers remain callable fetch functions. They additionally expose
`close()` to drain connections and `destroy()` to abort them. The creator owns the
dispatcher. An app created by the SDK exposes `close()`; an authorization result
exposes an optional `close` callback. Temporary discovery probes and failed
connections clean up SDK-owned transports. Injected fetches remain borrowed.
Consume or cancel response streams before graceful close. These transport methods
do not stop the daemon or revoke an app's authorization.

The model controller owns an install attempt synchronously, so repeated clicks
cannot start duplicate streams and an earlier attempt's finalizer cannot remove a
retry. Unmount detaches SSE; Cancel uses the server's explicit cancellation route
for both locally started and discovered downloads. Install polling does not overlap,
preserves local progress, and refreshes inventory when a remote job disappears,
including when another job remains active. Idle polls no longer reload MLX model
metadata repeatedly. Fitness polling remains independent of download polling.

The content mechanics receive only scoped I/O callbacks. They do not receive a
client or choose between authorities. All three adapters now filter listings to
their container root and preserve permission/storage failures; only typed 404s
become missing-file results. Companion prefixes remain document-relative.

Regression coverage includes provider build/reset/retirement races, shutdown
retry, cloud preservation, real loopback TLS acceptance and rejection, SDK
transport ownership, install retry/cancel/unmount races, and the same content
operations against each of the three authority adapters. Existing engine-panel,
container, SDK, and machine-adoption suites exercise the integrations.
