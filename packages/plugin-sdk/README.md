# @bendyline/gezel-plugin-sdk

Helpers for writing [Gezel](https://github.com/bendyline/gezel) plugins.

> **Legacy: new integrations should use
> [`@bendyline/gezel-sdk`](https://www.npmjs.com/package/@bendyline/gezel-sdk).**
> This package is the historical extension surface. It stays published and
> supported so existing plugins keep working, but new capabilities land in
> `@bendyline/gezel-sdk`.

```bash
npm install @bendyline/gezel-plugin-sdk
```

## How a plugin works

A plugin is an ordinary npm package with a `gezel` field in its
`package.json`. The field names the plugin's entry script and the tools it
offers:

```json
{
  "name": "gezel-plugin-hello",
  "type": "module",
  "gezel": {
    "name": "hello",
    "description": "Greets people by name.",
    "entry": "./dist/plugin.js",
    "tools": [
      {
        "name": "greet",
        "description": "Say hello to a name",
        "input": { "type": "object", "properties": { "name": { "type": "string" } } }
      }
    ]
  }
}
```

When a gezel calls one of the tools, Gezel runs the entry script. It reads one
JSON request from stdin and writes one JSON response to stdout:

```ts
import { fail, log, ok, readRequest, writeResponse } from '@bendyline/gezel-plugin-sdk';

const request = await readRequest();

if (request.tool === 'greet') {
  const { name } = (request.input ?? {}) as { name?: string };
  log('info', 'greeting', { name });
  writeResponse(ok(`Hello, ${name ?? 'friend'}!`));
} else {
  writeResponse(fail(`Unknown tool: ${request.tool}`));
}
```

## Exports

| Export | What it does |
|---|---|
| `PluginManifestSchema`, `ToolDefinitionSchema` | Zod schemas for the `gezel` field and each tool in it |
| `PluginRequestSchema`, `PluginResponseSchema` | Zod schemas for the request on stdin and the response on stdout |
| `readRequest()` | Read and validate the JSON request from stdin |
| `writeResponse(response)` | Write a response to stdout |
| `ok(output?)` / `fail(error)` | Build a success or failure response |
| `log(level, message, extra?)` | Write a structured log line to stderr, which Gezel shows in the task log |

## Stability

Public API under semver. It is maintained for compatibility; expect new
capabilities to land in `@bendyline/gezel-sdk` rather than here.

MIT © Bendyline
