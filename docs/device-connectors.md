# Device connectors

A **device connector** binds a project to local hardware instead of a remote
source. Cameras are the first family (`camera-local`: webcams and built-in
cameras). The connector framework's other connectors are *passes* — list,
fetch, write, close, on a 90-second idle-gated tick. A device is a *loop* that
runs until it is told to stop, so it has its own host and never enters the
sync loop. The person-facing companion is [lookouts.md](./lookouts.md); the
decision record is [ADR 0025](./decisions/0025-device-connectors.md).

## Shape

```
camera-local binding (driver: 'device')
  │
  ▼
LiveConnectorHost ── one capture per physical device (CameraSourcePool)
  ├─ ffmpeg pipe:1  160x90 gray ──► MotionDetector (motion + presence, core)
  │                                     └─ EpisodeTracker (core)
  ├─ ffmpeg pipe:3  MJPEG ──► ring buffer ──► storage policy ──► private captures/
  └─ episode ──► review schedule ──► CameraReviewer ──► RecognitionManager (structured, uncached)
                        └─► event record (connector writer) ──► CameraEvent ──► LookoutManager
```

| Piece | Where |
|---|---|
| Driver value, binding fields (`driver`, `disabledReason`), `projectAcceptsLiveWork` | `packages/core/src/schemas/{catalog,project}.ts` |
| Wire types (`CameraDevice`, `LiveBindingStatus`, `CameraEvent`, `parseCameraBindingConfig`) | `packages/core/src/schemas/devices.ts` |
| Motion/presence, episodes, storage and review policy, the review prompt | `packages/core/src/camera/` (pure, reusable on the phone) |
| Live host, gating, registry | `packages/service/src/connectors/live/` |
| Camera family: ffmpeg args, discovery, capture, captures store, pipeline, reviewer, event writer, simulator, frame access | `packages/service/src/connectors/live/camera/` |
| Routes | `routes/devices.ts` (`/api/devices/cameras…`), `routes/connectors.ts` (`PATCH`, `/preview`, `/captures…`), `routes/lookouts.ts` (`/cameras/look`) |
| UI | `components/cameras/`, the Connections tab, `WatchingIndicator` in the titlebar |

## The live host

`LiveConnectorHost` reconciles running devices against disk on boot, on any
binding change (`ConnectorManager.onBindingsChanged`), on any config write,
after the computer wakes (`onSuspension`), and once a minute as a safety net.
Each running binding gets a loop: run the adapter until it stops, show why,
back off (2 s → 5 min), retry. A watchdog measured in awake time restarts a
run whose device went silent (30 s for a camera). Status lives in memory and
goes out on the project stream as `camera_status`; `lastError` is written to
the binding only when it changes. `cameras_watching` (global) lists every
camera that is on, which the titlebar indicator shows.

The sync loop never sees a device binding: `ConnectorSyncManager.listBindings`
filters them out (otherwise a binding that never syncs makes its project "due"
on every tick), `syncProject` skips them, and the manual sync route refuses
them.

## Gating

`liveGate` ([live/gating.ts](../packages/service/src/connectors/live/gating.ts)):

| | Webcam | Network camera (future) |
|---|---|---|
| Runs | not paused, project not readonly/inactive/archived (stable is fine), not machine-shared, engagement not **Off** | same, plus `allowConnectorData` |
| Vision review | `isTaskWorkAllowed` (Proactive or Tasks + chat) and the binding's `review` | same |

Not `projectAllowsAmbientWork`: the task lifecycle sets `stable` on its own
when a project's last task finishes, and a camera that went deaf because a
craftbook completed would be a bug. Chat-only engagement keeps a camera
recording; only its reviews and lookouts wait.

**Emergency stop** pauses every device binding with
`disabledReason: 'emergency-stop'`; only the person's Resume clears it.

## Capture

One ffmpeg per physical camera (`CameraSourcePool`), shared by every binding
on that device, with two outputs at 2 fps that pair one-to-one:
`pipe:1` carries 160x90 grayscale for the detector, `pipe:3` MJPEG (long edge
capped at 1280) for storage and review. Pipes, not `-update 1` files: nothing
reaches disk unless the storage policy keeps it, and an ffmpeg orphaned by a
crashed daemon dies on its next write (verified on Windows) instead of holding
the webcam. The argument builders never reuse the indexer's `SAFE_INPUT`.

Discovery: DirectShow's "Alternative name" on Windows (stable across a replug
into the same port), AVFoundation device names on macOS (screen-capture
devices are filtered out — a camera connector must never become a screen
recorder), `/dev/v4l/by-id` links on Linux. ffmpeg comes from `locateFfmpeg()`
(`GEZEL_FFMPEG`, then PATH); without it the setup panel shows the install
command. Failures are translated to plain words (`classifyCaptureError`),
including Windows' "Let desktop apps access your camera" switch.

`GEZEL_CAMERA_SIMULATOR=1` adds a "Simulated mud room" that replays an empty
room, a cat walking in, squatting still, and leaving; each JPEG carries its
scene step in a comment segment and the reviewer answers from it, so the whole
pipeline runs in tests and evals without hardware or a vision model.
`GEZEL_CAMERA_SIMULATOR_START=<seconds>` skips ahead in the scene.

## Perception

`MotionDetector` scores the **largest blob**, not the changed fraction, so
sensor noise never adds up to a subject. **Motion** is frame-to-frame change;
**presence** is difference from a reference of the empty scene, compensated
for uniform exposure drift — a cat squatting still is not moving, but it is
present, and that is the moment worth reviewing. More than half the frame
changing at once is a lighting change (a lamp, the IR switch) and re-seeds
the model. The reference is refreshed only after two quiet minutes, after an
episode that ended by standing still, or after a review that found nothing
notable.

`EpisodeTracker`: two of three frames moving start an episode; eight seconds
with neither motion nor presence end it; something present but motionless for
three minutes ends it too (it is part of the room now); 30 minutes is the cap.

Reviews (`reviewDue`): one second after the episode starts (on the strongest
motion frame), then every 15 seconds while it lasts, at most 8 per episode.
`CameraReviewer` is install-wide: one review in flight, a newer frame replaces
a camera's waiting one, 120 an hour, a 90-second awake budget that also
bounds the engine's wait for memory. One structured call per review asks for a
one-line summary, the subjects in view, `notable`, and a yes/no answer per
lookout question (keyed `q1…qN`, never lookout ids). Measured on this
machine's GPU with Granite Vision 4.1 4B: 5.8 s cold, 0.6 s warm.

`RecognizeInput` gained `prompt`, `cache: false` (camera frames would grow
the cache forever), and `signal`; the cache key now includes the extract
schema and prompt, which it previously ignored.

## What lands where

| What | Where | Rules |
|---|---|---|
| Saved frames | `projectPrivateDir/captures/<corpus>/YYYY-MM-DD/HH/HHMMSS-mmm.jpg` | Private sidecar, never artifacts (artifacts may be cloud-synced or machine-shared). Bounded by `keepDays` and `maxGigabytes`, paused below ~5 GB free. Deleted with the binding unless the person keeps them. |
| The live view | memory only | `/preview` serves the newest frame; nothing is written for it. |
| Event records | `artifacts/<corpus>/events/YYYY-MM-DD/HH/NNN--HHMMSS-<subject>--hash.md` + `attachments/NNN/{keyframe-1..3.jpg, episode.json}` | The ordinary connector writer (trust frontmatter, injection scan, `_` rule). Hourly folders keep the 3-digit ordinal under 999; at most 60 a camera an hour; swept after 90 days. Written when the episode is interesting: a notable review, a lookout's yes, or every episode when nothing reviews. Bodies use plain filenames, never image embeds. |

## Pictures and models

`cameraPixelsWithheld` ([camera/frame-access.ts](../packages/service/src/connectors/live/camera/frame-access.ts)):
a camera's keyframes reach the person's own app and sessions on an on-device
model. A cloud-model session gets a local description instead — in
`read_image_as_base64` (403 with a pointer to the record), in chat image refs
(`resolveTurnImages`' `withholdPixels`), and in `look_at_camera` — unless the
binding's `allowCloudModels` is on. Session tokens can't reach `/preview`,
`/captures…`, bind, sync, patch, or unbind (`scope-guard.ts`).

## Adding another device family

Register a `LiveAdapter` with `registerLiveAdapter(adapterId, adapter)`, ship a
gilde manifest with `driver: 'device'` and `source: { adapterId, family }`
(`source.network: true` puts it behind `allowConnectorData`), and report status
and heartbeats through the run context. Keep raw samples out of artifacts and
turn what matters into ordinary records.

## Not yet

Network cameras (RTSP, HTTP snapshots, MJPEG, Digest auth), ONVIF discovery, a
macOS AVFoundation helper for daemons not hosted by Gezel.app (a LaunchAgent's
camera prompt is attributed to `node`), a pinned ffmpeg download, exclusion
zones, an EmbeddingGemma pre-filter before the vision model, and a
`detections` observation table.
