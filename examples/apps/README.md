# Sample AI Apps

Three complete `.gezapp` source folders, graded so you (or an AI agent) can start from the smallest shape that fits and copy upward. Each validates with zero findings and is packed, installed, and applied against the real service by [examples-apps.test.ts](../../packages/service/src/project-type/examples-apps.test.ts) on every test run.

| Sample | Adds | Read it for |
| --- | --- | --- |
| [example-journal](example-journal/README.md) | The minimal shape | Layout, identity vs version, params, a solo crew |
| [example-habit-tracker](example-habit-tracker/README.md) | State + interface | Seeds, both script forms, tools with `bind`, page reactions, the Output page |
| [example-reading-circle](example-reading-circle/README.md) | A working crew | Multiple roles, embedded + catalog craftbooks, night-shift schedules, dependency locks |

The loop:

```bash
gezel app new my-app          # or copy a sample
gezel app schemas --out schemas   # JSON Schemas for your editor or AI
gezel app validate my-app     # collect-all findings; --json for tooling
gezel app pack my-app         # my-app-1.0.0.gezapp
gezel app add my-app-1.0.0.gezapp --yes
gezel app apply my-app        # inside the folder that becomes the project
```

The full guide is the Handboek article [Building AI Apps inside Gezel](../../docs/handboek/technical/building-ai-apps-inside-gezel.md); the format reference is [docs/project-types.md](../../docs/project-types.md).
