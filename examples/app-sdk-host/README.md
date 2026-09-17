# Hosting gezel inside an application

One runnable script for the whole embedding path: host a daemon in-process,
install an AI App, register a tool the host application implements, and chat
with the app's gezel.

```bash
pnpm build                                   # once
node examples/app-sdk-host/host-in-proc.mts  # mock model, no network
node examples/app-sdk-host/host-in-proc.mts --real
```

Everything lands in a temporary home that is deleted on exit, so your own
`~/.gezel` is untouched. `--real` provisions Gemma 4 E2B for real, which
downloads a native engine and a couple of gigabytes of weights.

Run it from this repository: it resolves `@bendyline/*` through the workspace's
own `node_modules`. In your application these are ordinary npm installs —
`@bendyline/gezel-app-sdk` plus `@bendyline/gezel-service` (an optional peer,
needed only to host).

The API is documented in [the app SDK README](../../packages/app-sdk/README.md)
and the Handboek article [Building connected apps with
gezel-app-sdk](../../docs/handboek/technical/building-connected-apps-with-gezel-app-sdk.md);
the tool relay's design is [ADR 0013](../../docs/decisions/0013-app-tool-relay.md).
