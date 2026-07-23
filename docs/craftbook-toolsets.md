# Craftbook toolset dependencies

A craftbook can declare the toolsets (MCP servers / CLIs / hosted APIs) it
depends on, up front, via an optional `toolsets` array on its version manifest.
This does three things:

1. **Discoverability + setup.** The command launcher surfaces a "needs setup"
   affordance on any craftbook with a *required* toolset that isn't installed,
   and lets the user install + configure it inline (reusing the normal toolset
   install/config form) before the craftbook runs.
2. **Pre-authorization ("fast-track permissions").** A toolset marked
   `autoAllow` has all of its tools pre-approved for the duration the craftbook
   is active — the gezel isn't prompted per call. This is what makes an
   unattended/scheduled craftbook (e.g. a periodic camera pull) run without
   stopping to ask each cycle.
3. **Coherent declaration.** Instead of the dependency being implicit across a
   step script (`gezel.mcp.call('…')`), a gezel `tools` allowlist, a hand-written
   guard hook, and ad-hoc credential entry, it's stated once.

It is distinct from `requirements` (the `github` / `non-main-branch` booleans):
a missing `requirement` *hides* a craftbook; a missing `toolset` keeps it listed
and offers setup.

## Schema

```ts
toolsets?: Array<{
  toolsetId: string;     // catalog toolset id, e.g. "github", "usb-camera"
  sourceId?: string;     // catalog source provenance (bundled/community), when pinned
  minVersion?: string;   // optional semver floor (recorded; presence not yet enforced)
  optional?: boolean;    // true = suggestion (hint only); default = required (offers setup)
  autoAllow?: boolean;   // pre-authorize this toolset's tools while the craftbook is active
  reason?: string;       // human-readable rationale shown in the launcher
}>
```

The field is carried end-to-end: catalog version manifest →
`CraftbookTemplateManifest` → runtime `Craftbook` → the task's embedded craftbook
snapshot (`task.craftbook.toolsets`). The snapshot is what the chat session reads
to derive the auto-allow set, so live tasks stay insulated from later edits to the
template.

## How `autoAllow` is enforced

Both permission paths derive their pre-authorized tool set from the *same*
helper, `autoAllowedToolsForToolsets` — it resolves each `autoAllow` toolset's
catalog manifest and unions its `tools[].name`:

- **In-process providers.** At session build, a static-decision `PreToolUse`
  hook is synthesized (`{ decision: 'allow' }`, matcher anchored to the toolset's
  tool names) and installed on the MCP bridge through the existing craftbook-hook
  pipeline. Static-decision hooks need no script runner. A craftbook's own guard
  hooks still apply — a guard `deny` wins over a blanket allow.
- **Claude-CLI-backed gezels.** The CLI permission broker
  (`POST /api/permissions/request-and-wait`) checks the tool against
  `ChatManager.autoAllowedToolsForSession(sessionId)` and returns
  `{ behavior: 'allow' }` immediately, skipping the approval prompt.

A coarser per-gezel lever for CLI gezels remains the `claudePermissionMode`
frontmatter (`acceptEdits` / `bypassPermissions`).

## Example: an existing craftbook

`pull-request-review` declares the `github` toolset as an optional, pre-authorized
dependency — it doesn't block the craftbook (PR review still works via built-in
GitHub tools), but when the GitHub MCP toolset is installed, its tools run without
a per-call prompt:

```json
"toolsets": [
  {
    "toolsetId": "github",
    "optional": true,
    "autoAllow": true,
    "reason": "read PR metadata and post review comments without a prompt per call"
  }
]
```

## Example: a Home Monitoring craftbook

The headline scenario — a scheduled craftbook that pulls frames from a network
camera and has a gezel analyze them — combines a cron schedule-host task, a step
script that calls the camera toolset's MCP tool, a vision gezel, and a *required,
auto-allowed* toolset so the loop runs unattended:

```jsonc
{
  "schemaVersion": 1,
  "version": "1.0.0",
  "releasedAt": "2026-06-06T00:00:00Z",
  "about": "about.md",
  "entryStepId": "capture",
  "triggers": ["check the cameras", "pull camera frames"],
  "bundledScripts": ["pull-frame.ts"],
  "toolsets": [
    {
      "toolsetId": "usb-camera",
      "autoAllow": true,
      "reason": "pull frames from the network camera unattended each cycle"
    }
  ],
  "steps": [
    {
      "id": "capture",
      "name": "Capture frame",
      "onEnter": { "name": "pull-frame" },
      "next": "analyze"
    },
    {
      "id": "analyze",
      "name": "Analyze frame",
      "suggestedRole": "analyst",
      "prompt": "Inspect the captured frame for anything noteworthy and write a short note.",
      "terminal": true
    }
  ]
}
```

`pull-frame.ts` is an ordinary craftbook script that reaches the toolset by name
and declares the capabilities it needs:

```ts
import { defineScript, gezel } from '@bendyline/gezel-sdk';

export const meta = defineScript({
  name: 'pull-frame',
  description: 'Pull the latest frame from the network camera and save it as an artifact.',
  requires: ['network', 'credential:usb-camera.token', 'artifacts.write'],
});

const frame = await gezel.mcp.call('camera_snapshot', { camera: 'front-door' });
await gezel.artifacts.write('frame.jpg', frame);
gezel.output({ ok: true });
```

To run it on a schedule, create a schedule-host task whose `cron` spawns this
craftbook (see `TaskCronSchema` / `spawnsCraftbook`). Because `usb-camera` is
`autoAllow`, the `camera_snapshot` tool is pre-authorized and the scheduled run
never pauses for approval.

> The `usb-camera` toolset above is illustrative. Wiring a real network camera
> means shipping (or installing from the community catalog) a toolset whose MCP
> server exposes a snapshot tool, with config fields for the camera's base URL
> and an auth token (the token marked `secret` so it's stored in the OS keychain).
