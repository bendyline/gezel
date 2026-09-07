# Native engine memory admission

Every Gezel-managed native child reserves memory before it starts allocating:
llama.cpp, MLX, DS4, image recognition, image generation, video generation, and
Whisper. The reservation belongs to the physical child, not to a logical chat
turn or a provider object. It covers planned resident weights and caches;
engines without a planner use installed weight sizes plus scratch headroom.

## One authority for cooperating daemons

Installed systems use the machine engine broker's private SQLite ledger. An
isolated development or evaluation daemon still asks that broker for memory,
even with `GEZEL_DISABLE_MACHINE_ENGINE=1`: inference can run its own binary
while sharing the resource authority. The loopback-only endpoint is
`POST /v1/remote/manage/native-capacity`, protected by the existing inference and
machine-model-management scopes. It accepts reservation IDs, byte counts,
priorities and PIDs, never project paths, prompts or executable commands.
Broker discovery verifies the signed device identity and pins TLS. Certificate
rotation re-verifies the same identity; a broker outage never moves its clients
to a second ledger.

Without an installed broker, daemons for the same OS account share
`~/.gezel/runtime/native-capacity/leases.sqlite`, independently of `GEZEL_HOME`.
The broker stores its ledger under its private `native-capacity/` directory,
outside the readable runtime discovery directory. SQLite transactions make
check-and-reserve atomic across processes, and claims survive coordinator
restart. Tests override `GEZEL_NATIVE_CAPACITY_DIR` to avoid live user state.

## Admission and scheduling

- Both the total memory budget and the accelerator budget must fit. The
  configured model budget can lower the automatic ceiling. On unified-memory
  hosts, accelerator commitments are capped at 75% of physical RAM even when
  the pageable RAM budget is larger.
- Live reclaimable RAM and available discrete GPU memory provide an additional
  check against other applications. Reservations still loading count against
  the live sample because they may not have allocated their bytes yet.
- On macOS, physical GPU model loads are serialized through readiness. Once
  loaded, models can run concurrently when their reservations fit. The old
  platform-wide automatic swap heuristic no longer decides residency; an
  explicit user `swap` setting remains supported.
- DS4 full residency is explicitly exclusive. The historical 96 GiB estimate
  alone cannot express exclusivity on larger machines. Image and video engines
  are also exclusive until they expose reliable peak-allocation planners.
  DS4 streaming and smaller chat/recognition/audio engines can coexist within
  their budgets.
- Interactive loads take priority, with FIFO order within each lane. After
  four newer admissions bypass an older claim, that claim takes precedence.
  A large request therefore gets a chance to accumulate enough free capacity.
- An engine needed by a waiting claim stops accepting fresh physical requests,
  finishes active requests, flushes idle caches, and unloads. Only its owning
  supervisor stops it. Logical turns parked on tools do not pin GPU memory.
- Admission waits report “Waiting for available memory,” support cancellation
  during supervisor shutdown, and expire after five minutes of awake time with
  an actionable capacity error. Waiting does not consume the native crash
  restart budget.

Concurrent lazy starts share one admission. A replacement child cannot start
until the stopping child exits. Failed spawns release their reservations;
dead queued owners and exited children are removed. A surviving orphan keeps
its memory reserved after its parent dies. An unbound grant whose owner died
in the narrow spawn/bind window is deliberately retained for operator review,
rather than reclaimed by a timeout that could admit work over a live child.

## Boundaries and validation

This is cooperative admission, not an OS memory sandbox. External servers,
older daemons, and arbitrary applications can still allocate memory without a
reservation. Live pressure checks reduce that risk but cannot prevent their
future allocations or guarantee an estimate matches every runtime peak.
Without an installed broker, different OS accounts do not share a ledger.
Broker discovery that begins after fallback engines are already resident also
relies on live pressure while those earlier engines drain. Updated daemons must
be restarted to participate; an older installed broker must be updated before
it can coordinate isolated engines through the new endpoint.

Regression coverage includes two actual Node processes racing for one budget,
the reported DS4 83.1 GiB plus 15.5 GiB competing allocation, fair queueing,
load serialization, cancellation, orphan survival, safe request draining,
stop/start races, broker restart and identity rotation, and authenticated route
boundaries. These tests use simulated allocations, not live large-model loads.
