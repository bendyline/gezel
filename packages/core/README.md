# @bendyline/gezel

Core types, Zod schemas, path helpers and the gezel-markdown parser shared by
every part of [gezel](https://github.com/bendyline/gezel).

This package is the single source of truth for gezel's wire types. Both the
daemon and the web UI import it, so it depends on nothing beyond Node built-ins.

```bash
npm install @bendyline/gezel
```

## Entry points

| Subpath | Contents |
|---|---|
| `@bendyline/gezel` | Logger, shared types, and the re-exported surface below |
| `@bendyline/gezel/schemas` | Every Zod schema and its inferred TypeScript type |
| `@bendyline/gezel/paths` | `gezelPaths()` and every path helper for `~/.gezel/` |
| `@bendyline/gezel/markdown` | The `gezel.md` frontmatter + sections parser |
| `@bendyline/gezel/native` | Native binary discovery and platform keys |
| `@bendyline/gezel/checks` | Gate-check primitives used by craftbook scripts |

```ts
import { GezelSchema } from '@bendyline/gezel/schemas';
import { gezelPaths } from '@bendyline/gezel/paths';

const paths = gezelPaths();
const gezel = GezelSchema.parse(await loadSomething());
```

## Stability

Public API under semver. Adding a new schema field is a minor; removing or
narrowing one is a major.

MIT © Bendyline
