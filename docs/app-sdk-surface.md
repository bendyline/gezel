# App SDK surface

The engineering contract for `@bendyline/gezel-app-sdk`. The handboek page
[building connected apps](handboek/technical/building-connected-apps-with-gezel-app-sdk.md)
teaches the SDK; this page says what is promised.

The [desktop/mobile packaging plan](app-sdk-mobile-packaging-plan.md) proposes
portable intelligence APIs and prebuilt native dependencies. Those proposed
surfaces are not part of the current contract below.

Consumers pin this package by exact version and, in at least one case, behind a
release-age cooldown. An export that appears or disappears unnoticed is a
contract change nobody reviewed, so `packages/app-sdk/src/surface.test.ts` pins
the runtime exports of every entry point. Updating that test is the deliberate
act; its diff is the review.

## Entry points

| Entry | For | Needs |
|---|---|---|
| `.` | Software running beside a Gezel the user installed. Discovery, consent, OpenAI-shaped inference. | Node |
| `./browser` | A renderer handed a `baseUrl` and token by its own host process. | Nothing |
| `./host` | Running a daemon inside the consuming app. | Node, plus `@bendyline/gezel-service` as an optional peer |
| `./advanced` | The escape hatch. Unsupported. | Node |

`./browser` is deliberately the smallest: discovery, consent and hosting all
need the filesystem. A browser cannot do the consent handshake at all — the
daemon refuses app registration from any request carrying an `Origin` — so a
browser consumer's desktop half performs consent and passes the result in.

## Stability

Additive through 1.x. Specifically:

- **Stable.** Everything exported from `.`, `./browser` and `./host` that is not
  marked otherwise below.
- **Deprecated.** `Gezel.client`. It returns Gezel's internal product client:
  hundreds of methods, versioned with the daemon rather than with this SDK, and
  speaking Gezel's own vocabulary. Reach it through `unsafeProductClient` from
  `./advanced` instead, so the dependency is visible in a consumer's imports. It
  stays until a deliberate 2.0.
- **Not contract.** Everything under `./advanced`. `ModelListEntry.gezel_id` and
  `.role`, which surface a Gezel concept inside an otherwise OpenAI-shaped
  payload. The `ChatTurnEvent` `other` payload, which exists so that a new
  daemon event is not a breaking change.

Reserved for extension, so do not switch exhaustively on them: `EnsureModelEvent.type`,
`ChatTurnEvent.type`, and the `code` on `GezelSdkError`.

`EnsureModelEngine` is the exception that proves the rule. It is a **closed**
union of the daemon's own provider names, because the value is used to pin the
default provider and a name this SDK invented would be rejected there. Adding an
engine is a coordinated minor release of the SDK and the daemon together.

## Cancellation

Every request-shaped method on `GezelApp` takes a second `RequestOptions`
argument carrying an `AbortSignal`, matching the OpenAI SDK shape rather than
putting a signal in the JSON body:

```ts
const controller = new AbortController();
const stream = await app.chat({ model, messages, stream: true }, { signal: controller.signal });
controller.abort(); // stops the provider, not only our reading of it
```

An aborted call rejects with the platform's `AbortError` and is deliberately
**not** wrapped in `GezelSdkError`, so callers that already handle OpenAI-style
cancellation need no special case.

## Hosting

`connectOrHost` tries an explicit `baseUrl`, then the user's running Gezel, then
a daemon hosted by the consuming app — and only the last of those is opt-in.
By default only "nothing is running" falls through: a refusal, a timeout, or a
daemon that is alive but unwell all stay loud, because an app that quietly
started its own daemon after the user declined would be doing the thing they
declined. `hostWhenRefused: true` lets an app that obtains its own consent (its
AI is optional and the person switched it on inside the app) answer a refusal,
an expired or unanswered approval, or a disabled connected-app surface by
hosting instead. An alive-but-unwell daemon stays loud even then.

An app with no `onVerificationCode` handler cannot complete a new handshake,
but it still reuses a grant saved by an earlier session before hosting: joining
the Gezel the person already runs beats loading every model again in a private
daemon. This cannot raise a prompt — `authorize` refuses to register a new
grant without a code handler, and that refusal is what falls through.

A hosted daemon always listens on an ephemeral port. The canonical 6228 belongs
to the machine broker on a machine install and is the stable address the
user's own Gezel wants; a private daemon that happened to start first must not
take it.

`HostOptions.mode` decides how that hosted daemon runs.

- **`child`** spawns `gezeld` under `HostOptions.nodePath`. Native dependencies
  then load under real Node. Under Electron with no `nodePath`, the Node a
  Gezel install keeps at `<Gezel home>/bin/node` is used when present, so
  hosting works on a machine with Gezel installed without shipping one.
- **`in-process`** imports the service into the caller. Faster, no second
  process, but every native dependency must match this process's ABI.

The default is `child` under Electron and `in-process` elsewhere. Electron gets
the child by default because importing the service into its main process would
require `sqlite-vec`, `@napi-rs/keyring` and the rest to be rebuilt for
Electron's ABI. Spawning under a shipped Node sidesteps that, and is what
Gezel's own desktop shell does.

### Store builds

A consumer shipping to the Mac App Store or the Microsoft Store passes
`distributionProfile: 'store'`. The daemon then refuses every runtime download
of executable code — engines, toolsets, the Python runtime — while continuing to
allow data, which is what model weights are. That distinction is the whole
reason store distribution is possible; see
[store distribution](store-distribution.md) for the full lane.

A store consumer therefore ships every executable inside its signed package and
points `nativeBinDir` at the staged engine tree. `ensureModel` then finds the
engine already present and downloads only weights.

Two traps worth stating plainly:

- **Pass `engine: 'llama-cpp'` explicitly.** `ensureModel` defaults to MLX on
  Apple Silicon, and MLX provisions a Python environment at runtime, which the
  store profile refuses. Taking the default fails on exactly the hardware most
  likely to be tested first.
- **`nativeBinDir` is trusted on an existence check**, not verified against
  `native-file-manifest.json`. That is acceptable when the tree is inside a
  store-signed package and is the consumer's own; it is not a substitute for
  verification if the tree came from anywhere else.

## Testing against the SDK

`detectGezel` and `connect` both accept a `home`, so a consumer's test suite can
point at a fixture daemon without mutating `process.env.GEZEL_HOME` — which is
process-wide and so breaks as soon as two suites run in parallel.

Discovery reads `<home>/runtime/port` and falls back to plain HTTP when no
`cert.pem` sits beside it. A test double is therefore an ordinary HTTP server
plus a directory, with no certificate work.
