# @bendyline/gezel-client

Typed HTTP client for the [gezel](https://github.com/bendyline/gezel) daemon
(`gezeld`). Wraps every service endpoint — gezels, projects, sessions, chat
streaming, tasks, memories, models, engines and usage.

```bash
npm install @bendyline/gezel-client
```

```ts
import { GezelClient, streamChatEvents } from '@bendyline/gezel-client';

const token = process.env.GEZEL_TOKEN;
const gezelId = process.env.GEZEL_ID;
if (!token || !gezelId) throw new Error('set GEZEL_TOKEN and GEZEL_ID');
const client = new GezelClient({ baseUrl: 'https://127.0.0.1:8080', token });

const gezels = await client.listGezels();
console.log(gezels);

const session = await client.createChatSession({ gezelId, projectId: 'default' });
const reply = (async () => {
  for await (const event of streamChatEvents({
    url: client.sessionEventsUrl(session.id),
    headers: { Authorization: `Bearer ${token}` },
  })) {
    if (event.type === 'delta') process.stdout.write(event.content);
  }
})();
await client.sendToChatSession(session.id, 'hello');
await reply;
```

## Entry points

| Subpath | Contents |
|---|---|
| `@bendyline/gezel-client` | `GezelClient` and its request/response types |
| `@bendyline/gezel-client/node` | Node-only helpers, including `discoverOrSpawn()` for finding or starting a local daemon |

`discoverOrSpawn()` is how the CLI and the VS Code extension locate a running
daemon (or start one). It resolves the daemon entry point through
`require.resolve('@bendyline/gezel-service/dist/bin/gezeld.js')`, so
`@bendyline/gezel-service` must be installed alongside it for the spawn path.

## Stability

Public API under semver. This is the supported way to drive a gezel daemon
from your own code — prefer it over calling the HTTP API by hand.

MIT © Bendyline
