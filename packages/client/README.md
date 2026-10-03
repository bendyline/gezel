# @bendyline/gezel-client

Typed HTTP client for the [gezel](https://github.com/bendyline/gezel) daemon
(`gezeld`). Wraps every service endpoint — gezels, projects, sessions, chat
streaming, tasks, memories, models, engines and usage.

```bash
npm install @bendyline/gezel-client
```

With Gezel running on your computer:

```ts
import { connectToLocalGezel } from '@bendyline/gezel-client/node';

const { client, close } = await connectToLocalGezel();
try {
  const { gezels } = await client.listGezels();
  console.log(gezels.map((gezel) => gezel.name));

  const session = await client.createChatSession({
    gezelId: gezels[0]!.id,
    projectId: 'default',
  });
  await client.sendToChatSession(session.id, 'hello');
  for await (const event of client.streamSessionEvents(session.id)) {
    if (event.type === 'delta') process.stdout.write(event.content);
  }
} finally {
  await close();
}
```

There is no address, password, or certificate to configure. Gezel listens on
`127.0.0.1` on a port it picks at launch, over TLS with a certificate it makes
for that launch, and accepts a sign-in token that also changes each launch. It
writes all three to `~/.gezel/runtime/` (`$GEZEL_HOME/runtime/` for another
home), readable only by you. `connectToLocalGezel()` reads them, trusts that
one certificate, and follows Gezel across a restart: a request that finds the
old address gone, or the old token refused, reads the files again and is sent
once more. When Gezel is not running it throws `DaemonNotRunningError`, whose
message says to open the app or run `gezel start`.

Pass `{ home }` to reach a Gezel home other than the default.

This connects as you, with the access the `gezel` command has. To let an app
you give to other people use Gezel, use
[`@bendyline/gezel-app-sdk`](https://www.npmjs.com/package/@bendyline/gezel-app-sdk)
instead: the person approves it once, and it gets only the access it asked for.

### Connecting by hand

A `GezelClient` needs Gezel's own certificate to reach it. Node's built-in
`fetch` rejects a self-signed certificate with `DEPTH_ZERO_SELF_SIGNED_CERT`,
so pass a transport that trusts it:

```ts
import { GezelClient } from '@bendyline/gezel-client';
import { createTrustingFetchFromPath } from '@bendyline/gezel-client/node';

const client = new GezelClient({
  baseUrl, // https://127.0.0.1:<the port in runtime/port>
  token, // the contents of runtime/auth-token
  fetch: await createTrustingFetchFromPath(certPath), // runtime/cert.pem
});
```

All three values go stale when Gezel restarts, which `connectToLocalGezel()`
handles for you.

## Entry points

| Subpath | Contents |
|---|---|
| `@bendyline/gezel-client` | `GezelClient` and its request/response types |
| `@bendyline/gezel-client/node` | Node-only helpers: `connectToLocalGezel()` for the Gezel already running, `discoverOrSpawn()` for finding or starting a local daemon, and the TLS transports `createTrustingFetch()` / `createTrustingFetchFromPath()` |

`discoverOrSpawn()` is how the CLI and the VS Code extension locate a running
daemon (or start one). It resolves the daemon entry point through
`require.resolve('@bendyline/gezel-service/dist/bin/gezeld.js')`, so
`@bendyline/gezel-service` must be installed alongside it for the spawn path.

## Stability

Public API under semver. This is the supported way to drive a gezel daemon
from your own code — prefer it over calling the HTTP API by hand.

MIT © Bendyline
