---
id: npm-packages
title: "Gezel on npm: the package map"
order: 7
summary: Choose the command line, SDK, daemon, client, or lower-level package for your integration.
subcategory:
  id: gezel-command-line
  title: The Gezel Command Line
  order: 2
---

# Gezel on npm

The desktop app is the simplest way to use gezel, but the same system is also available as a family of npm packages. You can install the `gezel` command, write a repeatable script, connect another app to local models, embed the daemon, or reuse the schemas and clients that Gezel itself uses.

All eleven packages published from the Gezel repository require Node.js 24 or newer and expose public, semver-versioned contracts. You normally install only the package at the top of your use case; npm brings in its required Gezel dependencies for you.

## Choose your starting point

| You want to… | Start with |
| --- | --- |
| Use gezel from a terminal or server | [`@bendyline/gezel-cli`](cli-reference.md) |
| Write an automation that runs inside Gezel | [`@bendyline/gezel-sdk`](writing-scripts-with-gezel-sdk.md) |
| Let a desktop or Node app use the user's Gezel models | [`@bendyline/gezel-app-sdk`](building-connected-apps-with-gezel-app-sdk.md) |
| Call the full daemon API from TypeScript | `@bendyline/gezel-client` |
| Run or embed a daemon yourself | `@bendyline/gezel-service` together with `@bendyline/gezel-client` |
| Give an MCP client Gezel's tools | `@bendyline/gezel-mcp` |
| Share Gezel's schemas or parse its files | `@bendyline/gezel` |

For example, the command-line install is:

```bash
npm install -g @bendyline/gezel-cli
gezel
```

A library belongs in the application that uses it:

```bash
npm install @bendyline/gezel-app-sdk
```

## Every published package

| Package | What it does | Who normally installs it directly |
| --- | --- | --- |
| `@bendyline/gezel` | Core TypeScript types, Zod schemas, path helpers, the `gezel.md` parser, native-platform helpers, and reusable gate checks. It is the shared wire-contract source of truth. | Library authors who need Gezel's data contracts or on-disk formats. |
| `@bendyline/gezel-client` | Typed HTTP and event-stream client for the complete `gezeld` product API: projects, gezels, chats, tasks, scripts, models, memories, usage, and more. Its `/node` entry also contains local daemon discovery helpers. | Integrations that already have an authorized connection and need more than the OpenAI-compatible app surface. |
| `@bendyline/gezel-sdk` | The small, typed API available to TypeScript scripts inside Gezel's sandbox: `defineScript`, `gezel.fs`, `gezel.task`, `gezel.llm`, and the other capability-gated namespaces. | Script and craftbook authors. See [Writing scripts with gezel-sdk](writing-scripts-with-gezel-sdk.md). |
| `@bendyline/gezel-app-sdk` | Local discovery, pinned TLS, user consent, scoped token storage, model setup, chat, embeddings, and model listing for third-party applications. | Desktop and Node application developers. See [Building connected apps with gezel-app-sdk](building-connected-apps-with-gezel-app-sdk.md). |
| `@bendyline/gezel-plugin-sdk` | The historical plugin helper surface. It remains supported for compatibility, but new extensions should use `@bendyline/gezel-sdk`. | Maintainers of existing Gezel plugins. |
| `@bendyline/gezel-catalog` | Loads model definitions, toolsets, connector types, project types, gezel roles, and craftbooks from the separately released Gilde content. | Catalog tooling, tests, and embedders that need to resolve catalog items outside the daemon. |
| `@bendyline/gezel-connectors-spectral` | An isolated subprocess host for compatible Prismatic components. Keeping it out of the daemon process isolates its SDK and vendored connectors. | Usually nobody directly; `@bendyline/gezel-service` resolves and spawns it. |
| `@bendyline/gezel-script-stdlib` | The trusted, read-only standard library of gate scripts that ships with Gezel. Its plain TypeScript sources run in place under the `standard` script scope. | Usually the daemon; craftbook authors may inspect it for reusable standard checks. |
| `@bendyline/gezel-mcp` | The stdio Model Context Protocol server that exposes workspace, memory, artifact, document, task, team, execution, history, and media tools. It calls back into a running daemon. | MCP hosts and custom agent harnesses that need Gezel's tool surface. |
| `@bendyline/gezel-service` | `gezeld`, the local daemon. It owns state, provider routing, chat sessions, tools, tasks, engines, and the HTTP API, and includes the browser UI and Handboek. | Headless operators and applications deliberately embedding or managing a Gezel daemon. |
| `@bendyline/gezel-cli` | The `gezel` terminal interface, one-shot runner, service manager, model and engine manager, media commands, and Handboek exporter. It does not expose a supported JavaScript API. | People using [the gezel command line](cli-reference.md). |

## Packages that work together

`@bendyline/gezel-app-sdk` and `@bendyline/gezel-client` solve different halves of a connected application. The app SDK discovers the logged-in user's daemon, pins its loopback certificate, asks for consent, and returns a scoped connection. Pass that connection to `GezelClient` when the application also needs the full product API.

`@bendyline/gezel-service` is the runtime, while `@bendyline/gezel-client` is its supported control surface. Prefer the client over hand-written `/api` calls, and do not assume the service runs inside your process: the desktop app, CLI, and remote deployments all use the same HTTP boundary.

`@bendyline/gezel-sdk` is different from both. Its code runs *inside* Gezel's script sandbox and receives only the capabilities declared by the script. It is for automations attached to projects and craftbooks, not for connecting a separate application.

## The companion Gilde package

`@bendyline/gilde` contains the catalog data: model entries, toolsets, roles, craftbooks, connector types, and project types. It is released from the separate Gilde repository and consumed at an exact version by `@bendyline/gezel-catalog`. Install it directly only when you are working with the catalog content itself; ordinary Gezel consumers receive it through the catalog package.

The Electron app, React UI, VS Code extension, evaluation viewer, and deployment-only ML runtime are private workspaces rather than public npm packages. The desktop app and extension have their own distribution paths, the React UI is bundled into `@bendyline/gezel-service`, and the evaluation and ML workspaces support development and complete application builds.
