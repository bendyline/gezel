# UI architecture: keeping it fast

How the web UI (`packages/ui`) is built, measured and guarded, so it stays
responsive at the scale people reach: dozens of projects and crew, long chats,
replies streaming into them. There is one way to do each core thing; every
rule below came from a measurement, and the measurement is named so it can be
repeated. Visual rules live in [ux.md](ux.md).

## The seven rules

1. **Reading data goes through `data/`.** Server state is read with
   `useApiRead(name, args, { select, pollMs })` (or `useConfig(select)`) from
   [data/](../packages/ui/src/data/), a TanStack Query cache behind a
   first-party adapter. [reads.ts](../packages/ui/src/data/reads.ts) is the one
   table of shared reads, with how long each answer stays fresh and the scope
   that changes it. A view paints from the kept answer in its first frame and
   refreshes in the background. Older call sites still call `api.getConfig()`;
   `installApiReads` routes those through the same cache and hands each caller
   its own copy, so the two never disagree.
2. **Changing data ends in `setRead` or `dataChanged(scope)`.** A write marks
   reads stale (both sides of it, in `withReadInvalidation`); it never erases
   them. Stream events map to scopes in one table (`STREAM_EVENT_SCOPES` in
   [invalidation.ts](../packages/ui/src/data/invalidation.ts)). A read in
   flight when a write lands is cancelled and asked again, so a pre-write
   answer never stands as the fresh one. Writes that change no shared read
   (cache warming, draft autosave, preview leases) leave the cache alone.
3. **One owner per poll, paused while hidden.** A poll is a read with
   `pollMs`, mounted in the component that shows the value; anything else uses
   `setVisibleInterval`. Prefer a stream event to a poll. Refetches of an
   answer already on screen are background work for navigation timing.
4. **Navigation reads one registry.**
   [navigation/destinations.ts](../packages/ui/src/navigation/destinations.ts)
   declares each destination's code, the reads it paints from, its loading
   frame and whether it stays alive. A click highlights the rail at once,
   starts the code and the reads together, and holds the current view (at most
   120 ms) only when those reads are not in memory. The rail warms a
   destination on hover; after startup, `idle-warmup.ts` loads likely next
   destinations one idle period at a time, never while a turn is running. Its
   first load sets the `gezel:idle-warmup` performance mark, and the browser
   JavaScript budget for the first usable Home counts only script fetched
   before it.
5. **Recent destinations stay alive.**
   [KeepAliveHost.tsx](../packages/ui/src/navigation/KeepAliveHost.tsx) keeps
   Home and the newest three hidden destinations (one on a phone) mounted
   under React `<Activity>`, dropping one hidden ten minutes, one that crashed,
   and one whose project, gezel or document was deleted. Settings and the
   editors are never kept. See "Kept alive" below for what views must
   tolerate.
6. **Waiting holds the frame.** A destination's code loading for the first
   time shows its `PaneFrame` (wordless, the pane's size), never a blank pane
   or "Loading…". An empty state is claimed only once its read has answered.
7. **Rendering is memoized by default.** React Compiler compiles the UI (see
   below). Lists render memoized rows whose props keep their identity: data
   reuses unchanged objects (`mergeTimelineMessages`, structural sharing in the
   cache), handlers are stable (`useStableCallback`), and slices of fast-moving
   state are selected, not subscribed whole (`useActivitySelector`).

## Measuring

**In the app.** [nav-timing.ts](../packages/ui/src/nav-timing.ts) times every
move between views and every move inside one (a project's tabs), from the
person's click to the frame that drew the last response. Slow or jumpy moves
reach the service log as one line:

```
[perf] ui: opened project:fixture-project in 423ms, first frame 16ms, drawn 501ms,
content 371ms, 19 requests (+1 background), slowest GET …/timeline 138ms (daemon 45ms),
layout shift 0.03, renderer busy 5× (max 131ms)
```

- **drawn**: click to the frame after the last response the view read (the
  number that matches what a person sees).
- **content**: click to the first frame with the view's main content, such as
  a chat's messages (`markContentPainted`).
- **layout shift**: how far content moved while the view filled in, in
  Chromium's units (0.1 is noticeable, 0.25 poor). This is pop-in, measured.
  Shifts made only by the shell's frame changing mode (the rail folding for a
  list area) do not count: elements marked `data-layout-frame` are excluded.
- **background**: requests from polls and revalidations. They never hold a
  navigation open or count toward it.

**At scale, repeatably.** `pnpm --filter @bendyline/gezel-app run test:perf`
(after `pnpm build`) boots the in-process daemon, grows the browser suite's
world to 30 projects, 40 gezels, 60 sessions and a 2,000-message project
timeline, and writes `packages/app/test-results/ui-perf.json`: Home cold and
warm, a route through the large project and back (each step's report and the
elements that shifted most), a 20 KB reply streamed into the long timeline,
scrolling back through it, and the renderer's CPU while idle.
`GEZEL_PERF_PROFILE=1` adds a CPU profile and a main-thread trace of the
stream; `GEZEL_PERF_RUNS` sets the repeat count. The suite reports and never
fails on a number.

**Render counts.** Vitest pins the renders that matter: an activity poll that
changes nothing redraws no consumer (`activity-context.test.tsx`), a timeline
re-render with unchanged data redraws no bubble
(`ChatTimelineView.render-count.test.tsx`), and a burst of streamed tokens
redraws the live bubble once per frame
(`ChatTimelineView.streaming-perf.test.tsx`).

**What loads.** The UI build writes `dist/route-graph.json`: for the shell and
each destination, the chunks it must load before it can render, with sizes,
the chunk that pulled each in, and each chunk's largest modules.

## Guards

All run in `pnpm lint` or the UI build, and all are ratchets or caps at about
1.5x measured, so they catch a large regression rather than drift.

- [check-ui-startup-budget.mjs](../scripts/check-ui-startup-budget.mjs) caps
  the shell's startup graph, what Home and Projects load beyond it, and the
  chunk count.
- [check-react-compiler-coverage.mjs](../scripts/check-react-compiler-coverage.mjs)
  fails when a component that must stay memoized stops compiling.
- [check-ui-data-road.mjs](../scripts/check-ui-data-road.mjs) holds each file
  at its recorded count of direct shared reads, raw `setInterval` polls,
  `gezel:config-updated` listeners, `for await` loops in components and
  "Loading…" text. Converting old code lowers a count (`--update` records it);
  new code starts at zero.

## React Compiler

[scripts/vite-react.ts](../packages/ui/scripts/vite-react.ts) adds the
compiler to every Vite and Vitest config that renders the UI (the app, its
embedded, Office and phone builds, and the test suite, so tests run the code
that ships). It compiles what it can prove follows the rules of React and
leaves the rest alone, silently; each build writes
`react-compiler-report.json` saying which functions compiled and why the
others did not. The compiler refuses a whole component that contains any of:

- `try/finally`, a `throw` inside `try`, or a conditional, `?.` or `??`
  inside a `try`: move the operation into a module-level async function (the
  rail's document actions live in `sidebar-documents.ts` for this reason);
- a `for await` loop: use `useAllChatEvents` / `useProjectChatEvents` or
  `forEachEvent`;
- an inline `import()`: use a module-level loader;
- a ref written during render: write it in a layout effect;
- a `useCallback`/`useMemo` whose listed dependencies differ from what the
  body reads (a method called on an object reads the whole object):
  destructure first.

## Kept alive

A hidden view keeps its DOM and state; React runs its effects' cleanups on
hide and runs them again on show. So:

- An effect that loads data or resets state must not do so when it runs
  again for the same subject: compare with what it last handled (a ref), not
  with the first render. The chat timeline keeps its rows for an unchanged
  scope and reconciles in the background; a project already open refreshes
  instead of reopening (which reset its tab and file); the project chat
  resets its recipient only when the project changes (resetting on reveal
  remounted the whole chat and reloaded its transcript).
- Requests a reveal starts are background work: KeepAliveHost opens a
  background span around the view's effects (`openBackgroundSpan`), so they
  never hold the navigation open.
- A pinned chat snaps to its newest message on reveal, before paint. Hidden
  rows skip layout (`content-visibility`), so the offset a reveal keeps no
  longer points at the bottom; showing it as kept was a 0.32 layout shift.
- Live, streamed state is rebuilt on show from the shared stream's replay,
  not kept: kept, it would take the replayed deltas twice.
- Content that runs on its own while hidden reads `useLiveContentShown()`:
  streamed bubbles stop redrawing, and HTML pages unmount (a hidden page
  would keep running with its bridge to the app shut).
- Scroll positions are recorded as they change and put back on show
  (`display: none` drops them), unless the view places its own (a chat pinned
  to its newest message).
- Tests find a hidden view's text with `getByText`; wait for visibility
  (`toBeVisible`) after a navigation, not for presence. A selector that can
  match in more than one view scopes to the shown one (`shownView` in
  `packages/app/e2e/helpers/shown-view.ts`, the wrapper carrying `data-shown`):
  Home's chat opens the meester's newest thread, often the same thread a
  project shows, so an unscoped `.chat-timeline` finds Home's hidden copy first.
- The host arranges its kept set during render, and keeps that decision in
  one state (shown key, views, crashed views together). React drops an update
  made during render when another update to the same state is still waiting,
  and replays from the older state. With the shown key and the views as two
  states, the expiry tick landing mid-transition took the views back without
  the key, and the picked destination had no view: a blank pane until the next
  pick. The host also renders the shown destination even if the set lacks it
  (`withShownView`). Anything else that adjusts state during render follows
  the same rule.

## Rendering rules

- **No `:has()` anchored high in the tree.** Chromium re-checks a `:has()`
  rule's anchor on DOM insertions below it, and restyles the anchor's subtree
  when it does. `.app-body:has(.home-workshop)` and
  `.chat-rail-body:has(> .chat-rail-banner)` restyled about 3,500 elements on
  every frame of a streaming reply. State the shell already knows goes on as
  an attribute or class instead (`data-view` on the shell,
  `chat-rail-body-banner`). A `:has()` scoped to a small component is fine.
- **Off-screen threads skip layout.** Top-level chat threads carry
  `content-visibility: auto` (chat.css), except the newest twelve, which a chat
  opens on. Without it, each streamed frame laid out the whole transcript
  (66 ms a frame on 2,000 messages). Code that reads geometry must not measure
  inside skipped rows wholesale, since a read forces that row back into layout:
  measure top-level rows and descend only into the one you need, as
  `recomputeStickyHeader` does, and use document order where order is enough.
- **Snap before paint.** A scroll that decides what the first frame shows
  (a chat opening at its newest message) runs in a layout effect. As a passive
  effect it ran after the first paint and the chat flashed its oldest loaded
  messages first.
- **Hidden live content does not redraw.** A reply streaming inside a closed
  fold, behind a phone tab or in a hidden kept view stops updating until shown
  ([live-render-gate.tsx](../packages/ui/src/components/live-render-gate.tsx)).
- **Parsed markdown is reused.** Settled message text is parsed once and kept
  (`cachedChatDoc` in chat-bubbles.tsx), so reopening a chat does not re-parse
  every message; streaming text is parsed fresh and never kept.
- **One clock.** Counters that tick each second share one timer
  (`onSecondTick` in chat-bubbles.tsx), never an interval per instance.
- **Typing touches the editor only.** The composer's route preview reads the
  draft after typing pauses rather than on every key; Send checks the plan
  against the live draft, so the pause never decides a launch.

## Loading rules

- **Heavy code stays out of the shell.** The startup graph holds the shell
  only. A feature used after startup (search snippets, the search overlay)
  loads its renderer on demand and preloads it on intent.
- **Vendor code has stable files.** React, the query cache and the editor
  stack build into named chunks (`vite.config.ts`), so an app update that
  leaves them alone keeps their cached bytes and compiled code. Only families
  the shell uses whole are grouped: a group is one chunk.
- **Start reads at the click, but not ahead of the layout.** Prefetching a
  project chat's newest page at click time was tried and reverted: the
  conversation drew before the chat rail had decided on its Files pane, and a
  project with file references shifted by about 0.2 as the pane arrived.
- **Reads that do not depend on each other run together.** The chat timeline
  asks for its page, the turns in flight and the queue at once.
- **The phone preloads the UI while its service starts.** Its `index.html`
  lists the UI entry's import closure as `modulepreload`
  (`preload-ui-graph.ts`), and the bundled catalog loads beside the service
  setup rather than inside the entry.
- **Serving.** Hashed assets (`assets/`, `startup/assets/`) are cached
  forever; every other UI file revalidates against an ETag, so an unchanged
  shell or proofing engine answers 304 and keeps its compiled copy
  ([static-ui.ts](../packages/service/src/http/static-ui.ts)).

## Still to do

- The largest components still mix data, model and view:
  `ChatTimelineView`, `ChatComposer` and `ProjectsView` are each over 2,500
  lines and are not compiled (each holds `try/finally` or `for await`). Their
  split along data boundaries (a plain-TypeScript timeline model, a list and a
  scroll controller) is the next step, and lets a long transcript trim older
  pages once the reader returns to the bottom.
- Messages render as one list: the newest rows could mount first and the rest
  in a transition, and streamed markdown could freeze settled blocks and
  re-parse only the open tail. Streaming and scrolling are already within
  budget on 2,000 messages, so these wait for a measurement that needs them.
- Settings still shifts by about 0.12 as it fills in.
- The composer statically imports the rich text editor, which keeps about
  1.3 MB gzip in the first load of Home, Tasks, Crew and Craftbooks (the idle
  warm-up loads it after startup).
- Core's browser entry is not marked side-effect free, so the shell carries
  all of core's schemas, and the SVG sanitizer's XML parser.
- Squisq's `LinearDocView` injects a `<style>` per instance; React 19's
  `<style href precedence>` would dedupe it (a Squisq release).
