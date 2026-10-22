# 0025 — Device connectors: local hardware as a live, private connector

Status: Accepted (2026-10). Builds on [0009](0009-observation-corpora.md) and
[0021](0021-read-only-folders.md). Contract: [device-connectors.md](../device-connectors.md).

## Context

Every connector so far mirrors a remote source on a 90-second, idle-gated,
`allowExternalServices`-gated tick. A camera is the opposite in every
respect that matters: it must look continuously (a cat squats for thirty
seconds), it never touches the network, a frame per second would overrun the
document writer (3-digit ordinals, one `_flags.json` rewrite per record, the
20,000-file artifacts index walk), and its raw output is footage of a home.

## Decision

1. **A `device` driver with its own host.** `LiveConnectorHost` keeps device
   bindings running (reconcile on change, backoff, an awake-time watchdog,
   restart on wake). The sync loop never sees them; the binding stamps
   `driver` at bind so neither loop needs a catalog read to tell them apart.
2. **Raw frames are private; meaning is a record.** Saved frames go to the
   project's private sidecar (`captures/`), bounded and disk-guarded, never to
   artifacts, which can be cloud-synced or machine-shared. What happened
   becomes an ordinary connector record per *episode* with at most three
   keyframes, through the shared writer.
3. **One ffmpeg per physical camera, two pipes.** Grayscale 160x90 for a
   pure-TS motion/presence detector, MJPEG for storage and review, paired
   one-to-one. Pipes rather than files so nothing reaches disk unless kept,
   and so an orphaned ffmpeg dies with the daemon. Gezel uses the installed
   ffmpeg for now.
4. **Cheap first, model second.** The detector decides when the on-device
   vision model looks: once an episode starts, then every 15 seconds while
   something is moving *or present*, one review at a time across the install.
5. **Pixels follow the model's locality.** A camera's pictures reach the
   person's app and on-device sessions; cloud sessions get a local description
   unless the person allows cloud AI for that camera.
6. **Capture is not network traffic.** A webcam runs at every security level;
   only "Off" engagement stops it. Its reviews wait for task-work engagement.
   Emergency stop pauses every camera until the person resumes each one.

## Consequences

- A second family (a microphone, a sensor) is a `LiveAdapter` plus a gilde
  manifest; the host, gating, status and pause semantics are shared.
- macOS USB capture works when the daemon is hosted by Gezel.app; a
  LaunchAgent daemon's camera prompt is attributed to `node`, which needs an
  AVFoundation helper later.
- The UX rule "the camera runs only while its preview is on screen" now covers
  chat photos only; watching cameras are armed explicitly and always shown in
  the titlebar.

## Alternatives considered

- **A camera MCP toolset driven by a cron craftbook** (the illustrative design
  in craftbook-toolsets.md). Rejected: minutes between looks, a model call per
  look, and frames in the artifacts drawer.
- **Frames as observation rows.** Rows carry no bytes; the event-record shape
  is what makes a moment searchable and citable.
- **`-update 1` file output.** Writes every frame to disk and leaves orphans
  holding the device.
- **Capturing in the Electron renderer.** Only works while a window is open.
