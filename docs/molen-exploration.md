# Molen for small local models: an exploration

Status: exploration, 23 November 2026; Phase 0 measured 25 November 2026.
Nothing here is built. It records what Molen offers, what a small model
does with it today, what two prototype formats changed, and a proposed
path.

[Molen](https://molen.dev) (`@bendyline/molen-*`, sibling checkout `../molen`)
is Bendyline's 3D experience engine: a deterministic simulation kernel, a
three.js client, and a headless tool loop (validate, simulate, screenshot,
render frames) built so an agent can author a scene entirely through text.
The question: can Gezel let small local models (4B to 27B, 8k to 32k
windows) use it, in particular for animated scenes of people and places and
for short films (machinima)?

Short answer: yes, but not by handing them Molen as it is. A primer of about
1,600 tokens takes a 12B model from zero valid scenes to all valid scenes. The
scenes it writes are still poor films, for reasons a validator cannot see:
subjects out of frame, people walking into each other, lighting that renders
black. The lever that matters is a higher-level film format, compiled by
code into Molen scenes and camera tracks, so the model picks the cast, the
marks, the beats and the shots, and the runtime does the geometry. That
format belongs in Molen.

Phase 0 tested that with prototypes. A film document fixed every
collision, buried flag and dark frame on all three models. Games follow the
same rule more strongly: a 4B model asked for a raw Molen game made
nothing playable, and a three.js page that responded to keys none of the
time; asked for a game document that names a layout and its pieces, it
made 11 of 12 games a bot could win and lose. A drawn map, the first
version of that document, was too spatial for the 4B model and for every
platformer.

## What Molen already gives us

| Need | Molen today |
| --- | --- |
| A format a model can write | `molen/scene@3` JSON: entities with components, a scene camera. Errors name the JSON pointer, what was expected, and often a did-you-mean. |
| People and animals | Procedural figures: `human.adult`, `human.child`, `human.elder`, dog, cat, horse, deer, cow, sheep; height, build, hair, colors. They walk, run and turn on their own when moved; `figureIntent` sets sit or look-at. No GLB needed. |
| Movement | `tween` animates any component value over ticks with easing and looping. |
| Camera moves | `molen/cameratrack@1`: position and look-at keyframes over ticks, linear or smooth. |
| Frames for a film | `molen frames` (MCP `export_frames`) renders a tick range to a PNG sequence along a camera track, deterministically. |
| Headless checks | `validate`, `sim run --assert`, `shot`, `drive`; 45 MCP tools over one ops library (`molen mcp`). |
| Sound | Sound banks, positional sources, 170 CC0 clips including music; browser playback only. |
| Real places | Earth view: terrain, OSM buildings, roads, traffic, weather, sky; regions of 15 to 145 MB, landmarks in the GB range. |

## What a small model does with it

Probe, 23 November 2026, on an M5 Max: Gemma 4 12B (Q4, llama.cpp) and Qwen
3.5 4B (Q4, thinking off), four briefs, each answer checked with
`molen validate` and rendered with `molen shot` or `molen frames`. The
primer is in the probe folder and teaches only `transform`, primitive and
figure `renderable`, `figure`, `figureIntent`, `tween`, `light`,
`environment`, the scene camera and the camera track, with one example.

| Brief | No primer (12B) | Primer, first try (12B) | Primer, first try (4B) |
| --- | --- | --- | --- |
| Evening park: bench, two trees, lamp post | 0 of 2 | 3 of 3 | 1 of 3; 3 of 3 after one fix |
| A ball rolls across a table and back | 0 of 2 | 3 of 3 | 2 of 3; 3 of 3 after one fix |
| Two people meet in a square, a dog sits nearby | 0 of 2 | 3 of 3 | 3 of 3 |
| Camera closes in on a tower on a hill (scene and track) | 0 of 2 | 3 of 3 | 1 of 3; 3 of 3 after two fixes |

Without a primer Gemma invented a generic scene graph (`"type": "cube"`,
`"material": { "color": [...] }`); nothing it wrote resembles Molen. With
the primer every 12B scene and camera track validated on the first attempt.
The 4B model got 7 of 12 right first time and all 12 after at most two
rounds of feeding back `molen validate`'s message. Its mistakes were small
and the messages pinpointed each one: an invented value
(`"shadows": "soft"`), `loop` one level too high in a tween, a two-number
`size`. In the tower brief its corrected answers fixed the scene and left
out the camera track, which cost a second round: an answer made of two
documents is fragile.

The renders tell a different story:

- **Composition.** Every park scene renders nearly black. Gemma's
  "evening" became a sun pointing straight down at 0.1 intensity. Qwen's
  parks were dark for another reason: their grass was a `plane`, which
  Molen draws standing upright, so it hid the scene (laid flat, two of
  three become readable; Gemma's stay dark). Trees sat outside the shot.
  The people in the meeting scene are a few pixels tall.
- **Spatial sense.** In all six meeting scenes, from both models, the
  walker's destination is the other person's exact position: they walk
  into each other. Two of Gemma's three flags sit inside their towers, and "on a hill"
  became flat ground in five of six towers.
- **Copying the example.** The meeting brief was close to the primer's
  example, and the three answers are near copies of it. A primer example
  steers hard; examples must differ from what books ask for.
- **Traps the primer had to defuse.** A `plane` is drawn standing up:
  the schema says "plane = x by z", but the client builds it in the XY
  plane (`client/src/three/backend.ts:73`), and only Molen's starter scene
  tips it flat with a quaternion. Every floor a model writes as a plane is
  a wall. A figure without `"ref": "procedural"` fails validation;
  rotations are quaternions, which no small model should be asked for. The
  primer also left out that `sun.direction` points toward the sun (Molen's
  schema says so), which is how "evening" aimed it at the ground: every
  line a primer drops is a mistake waiting to happen.

So a primer solves syntax. Placement, framing, timing and light need a
format that does not ask the model for coordinates it cannot reason about.
This matches two standing rules in this repository: never ask a model for a
number the runtime can work out, and never ask it to retype what the
runtime already has.

## Phase 0: a film format and a game format, measured

25 November 2026, same machine. Two prototype compilers, one for a film
document and one for a game document, written in a scratch folder (nothing
in Molen or Gezel changed). Each emits an ordinary `molen/scene@3` that
Molen's own validator checks. Three models: Qwen 3.5 4B (thinking off),
Gemma 4 12B, and Gemma 4 26B A4B, standing in for Qwen 3.8 27B, which is not
installed here. Three samples per brief; a rejected answer got the
validator's message back, at most twice.

### Films

The four briefs from the probe, written as a film document from a primer
of about 600 words, against raw scenes (the probe's, and fresh ones for the
26B model). Raw scenes are scored with their floors laid flat, which
forgives them the plane trap above.

| Model | Format | Valid, first try | Valid after fixes | Readable light | Brief subjects visible | Meeting: nobody collides | Tower: flag outside / on a hill |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Qwen 3.5 4B | raw scene | 7 of 12 | 12 of 12 | 11 of 12 | 0.67 | 0 of 3 | 2 of 3 / 3 of 3 |
| Qwen 3.5 4B | film document | 8 of 12 | 12 of 12 | 12 of 12 | 0.82 | 3 of 3 | 3 of 3 / 3 of 3 |
| Gemma 4 12B | raw scene | 12 of 12 | 12 of 12 | 9 of 12 | 0.80 | 0 of 3 | 1 of 3 / 2 of 3 |
| Gemma 4 12B | film document | 12 of 12 | 12 of 12 | 12 of 12 | 0.93 | 3 of 3 | 3 of 3 / 3 of 3 |
| Gemma 4 26B | raw scene | 11 of 12 | 12 of 12 | 9 of 12 | 0.79 | 0 of 3 | 3 of 3 / 2 of 3 |
| Gemma 4 26B | film document | 11 of 12 | 12 of 12 | 12 of 12 | 0.81 | 3 of 3 | 3 of 3 / 3 of 3 |

"Brief subjects visible" is the share of moments in which what the brief
names (the bench, the ball and table, the two people, the tower and flag)
is in frame, large enough to see, and not behind a prop. A raw scene
usually keeps one fixed wide camera, which holds everything in view but is
hardly a film; the film documents cut between shots, and their remaining
misses are close-ups the model chose on one subject (the cat, not the
bench).

The format fixed what the probe found. In every meeting the walker stops
beside the other person instead of inside them, every flag flies outside
its tower, every tower stands on a hill, and every frame is lit. Syntax was
never the problem: the first-try failures were one small mistake each (an
undeclared ball, a shot called `slow-pull-out`, a mark written as a name),
named by the validator and fixed in one round.

**What the compiler had to learn.** Each rule came from a real answer, and
each is now the compiler's job, not the model's:

- A prop placed at another prop stands on it (a flag at the tower), and
  stays on its footprint (a ball cannot roll off the end of the table).
- Nobody starts or stops inside a prop. A walk stops a step short of the
  person it goes to and steps around anyone in the way. At the same moment,
  people sit and look before anyone walks toward them.
- A shot of something moving follows it. A close shot on two people widens
  to a two-shot taken across the line between them. A push-in ends on, and
  a pull-out starts from, the first subject named.
- A floor is a thin box, never a plane, and a figure looking at someone
  aims at their head.

These rules were added after reading the answers, and the answers were
then rescored with no new model calls, so the table shows what the format
does with a compiler that has learned them. None of them reads a
particular answer; each is a general rule of staging.

### Games

Molen is also a game engine, so the second question was whether a small
model can make a simple game with it. A read of Molen's four sample games
first:

| Need | Molen today | For a small model |
| --- | --- | --- |
| Set a game up | Good, as data: prefabs, input-to-command rules, a follow camera, timers, and three physics engines (two homegrown and deterministic: top-down `kinematics` and side-view `platformer`) | Usable with a primer |
| Rules of play | Script only. Pickups, damage, score, spawning, enemies, winning and losing are JavaScript in all four samples (119 to 189 lines each) | An unknown API under determinism rules, and one thrown error stops the world for good (`kernel/src/world.ts:696`) |
| Touch detection | The homegrown engines report a collision only when a body is pushed out of something; there are no trigger zones, so the samples check distances in script | Needs code |
| Level layout | 97 to 244 hand-placed entities per sample level | The film probe failed at spatial sense with five entities |
| Score, lives, messages | Nothing in the engine; each sample has 60 to 122 lines of page code | Needs code |
| Checking that a game works | Scripted command lists and end-of-run assertions; no bot, and no final state over MCP | No feedback a model can act on |

Four briefs: collect five coins in a walled garden while a dog patrols;
find a key that opens the door in front of a maze's exit while a guard
patrols; run and jump to a flag past gaps and two spike traps; survive 60
seconds in an arena as enemies keep arriving. Each with three lives. Four
ways to ask for them:

- **A. Raw Molen:** a scene plus one rules script, from a primer with one
  worked game and the contract a player bot needs.
- **B. A game document with a drawn map:** pieces with roles, a text map,
  and how to win and lose. A prototype compiler supplies the floor, walls,
  camera, controls, the rule for each role, score, lives and restart, with
  one fixed rules script that reads the document as data. It refuses a map
  in which the player cannot reach what matters.
- **B2. The same document with a layout:** the model names a layout
  (`garden`, `maze`, `arena`, or `level` for a platformer) and how many of
  each piece, and the compiler draws a level the player can finish. This
  arm was added after B's results, below.
- **C. A plain three.js page** from Gezel's page-library shelf, which is
  what a gezel writes today.

A bot plays every valid game twice: once trying to win (path-finding
around hazards, a simulated look-ahead to survive, reactive jumps), once
carelessly, to show the game can be lost. A game *plays* when the bot wins
and can also lose. A page (C) is loaded headlessly and passes when it
loads without errors, listens for keys and is not blank; that is an upper
bound, since a bot cannot drive arbitrary page code.

| Model | Arm | Valid, first try | Valid after fixes | Plays |
| --- | --- | --- | --- | --- |
| Qwen 3.5 4B | A. scene and script | 0 of 12 | 2 of 12 | 0 of 12 |
| Qwen 3.5 4B | B. document, drawn map | 0 of 12 | 2 of 12 | 2 of 12 |
| Qwen 3.5 4B | B2. document, layout | 10 of 12 | 12 of 12 | 11 of 12 |
| Qwen 3.5 4B | C. three.js page | 5 of 12 | 6 of 12 | at most 6 of 12; keys move something in none |
| Gemma 4 12B | A. scene and script | 4 of 12 | 12 of 12 | 5 of 12 |
| Gemma 4 12B | B. document, drawn map | 7 of 12 | 8 of 12 | 8 of 12 |
| Gemma 4 12B | B2. document, layout | 12 of 12 | 12 of 12 | 12 of 12 |
| Gemma 4 12B | C. three.js page | 10 of 12 | 12 of 12 | at most 12 of 12; keys move something in 11 |
| Gemma 4 26B | A. scene and script | 3 of 6 | 5 of 6 | 1 of 6 |
| Gemma 4 26B | B. document, drawn map | 6 of 12 | 9 of 12 | 6 of 12 |
| Gemma 4 26B | B2. document, layout | 12 of 12 | 12 of 12 | 12 of 12 |
| Gemma 4 26B | C. three.js page | 3 of 4 | 4 of 4 | at most 4 of 4; keys move something in 3 |

The 26B server stopped partway through A and C, and the rerun took one
sample per brief, so those two rows are smaller. Plays, by brief:

| Model | Arm | Coins | Maze | Platformer | Survive |
| --- | --- | --- | --- | --- | --- |
| Qwen 3.5 4B | A. scene and script | 0 of 3 | 0 of 3 | 0 of 3 | 0 of 3 |
| Qwen 3.5 4B | B. drawn map | 0 of 3 | 0 of 3 | 0 of 3 | 2 of 3 |
| Qwen 3.5 4B | B2. layout | 3 of 3 | 3 of 3 | 3 of 3 | 2 of 3 |
| Gemma 4 12B | A. scene and script | 3 of 3 | 0 of 3 | 0 of 3 | 2 of 3 |
| Gemma 4 12B | B. drawn map | 3 of 3 | 2 of 3 | 0 of 3 | 3 of 3 |
| Gemma 4 12B | B2. layout | 3 of 3 | 3 of 3 | 3 of 3 | 3 of 3 |
| Gemma 4 26B | A. scene and script | 1 of 3 | 0 of 1 | 0 of 1 | 0 of 1 |
| Gemma 4 26B | B. drawn map | 3 of 3 | 0 of 3 | 0 of 3 | 3 of 3 |
| Gemma 4 26B | B2. layout | 3 of 3 | 3 of 3 | 3 of 3 | 3 of 3 |

The games that play are also the games the brief asked for: with a layout,
10 of Qwen's 11 (one platformer had four spike traps, not two) and all 12
for both Gemma models.

**Why each arm fails.**

- **A, raw Molen.** Five of Qwen's twelve answers were not JSON: the rules
  script, written as a JSON string, carried raw line breaks. Most of the
  rest stopped the world on its first tick (`Math.random is not a
  function` under Molen's determinism sandbox, `guards.find is not a
  function`, a property read from `undefined`). Gemma's scenes all built
  after fixes, but only the coin game, the brief closest to the primer's
  worked example, plays reliably: in mazes the key never opens anything,
  platformers cannot be won, and one arena cannot be lost.
- **B, drawn map.** Molen's validator, extended with a reachability check,
  catches the failures: a coin or goal walled in, no player on the map, a
  door with no key. A model fixes some of them in two rounds, but drawing a
  maze whose only route runs through a door is spatial work: Qwen never
  managed it, Gemma 26B in none of three tries. No drawn platformer played
  at any size, because a model cannot tell how far a runner jumps; the
  goal was too high or past a gap too wide.
- **B2, layout.** The model makes only choices, and the level is drawn by
  code that knows the jump. One Qwen arena was unwinnable for the bot
  (chasers every five seconds at 3.5 m/s, up to the arena's limit); its two
  invalid first answers were a missing comma and an invented field, each
  fixed in one round.
- **C, page.** Half of Qwen's pages threw on load (an undefined variable,
  a property of `undefined`, assignment to a constant), and none of the
  pages that loaded moved anything when a key was pressed. Gemma 12B's
  pages all loaded and 11 of 12 responded to keys; whether any of them can
  be won or lost is unknown.

**A forgiving compiler did not help.** Instead of refusing a drawn map, a
repair mode moved each unreachable coin, key or goal to the nearest cell
the player could reach, and placed a missing player. More maps compiled
(Qwen 7 of 12, Gemma 12B 11, 26B 12), but no more played (4, 7 and 6 of
12): a moved goal lands a few steps from the start, so the game cannot be
lost, and repaired platformers still could not be won. Repair hides a
model's mistake; it does not make the game it meant.

**What the game compiler had to learn,** each from a real answer:

- A maze has loops, so a patrolling guard never blocks the only route, and
  guards start off the main route. The key lies far from the door, and the
  door is the only way to the goal.
- A platformer's gaps are as wide as this runner can jump, the ground never
  changes height beside a gap, and spike traps sit on level ground. A
  runner is never slower than 4 m/s (Qwen asked for 3, which clears no
  gap).
- In a survival game a chaser moves at most 0.6 times the player's speed,
  and arrivals stop once the arena is full (one enemy per 20 open cells).
- Every piece asked for is placed, or the level is drawn again from another
  seed.

As with films, the rules came after reading the answers, and the answers
were rescored with no new model calls.

**Against the bar set before Phase 0.** The film document removes the
composition failures it targeted, at every size: go. The game document as
first planned, with a drawn map, meets the 12B bar (8 of 12) but not the 4B
one (2 of 12, not clearly ahead of pages). Reshaped to name a layout, with
`map` kept for a model that wants to draw, it plays 12 of 12 at 12B and
11 of 12 at 4B, against none for raw Molen and at most 6 for pages, none of
which responded to a key: go, for the reshaped document. Two cautions. At
12B a plain page is a real rival for "something moves when I press a key";
the document's case there is that a play test proves it can be won and
lost, it runs no model-written code, and it plays the same on any host.
And the layout arm was designed after seeing B fail, with code making most
of the decisions, so these games are built from a short list of layouts and
roles; that is the trade the design intends.

## What gets in the way

1. **The model has never seen Molen, and the reference is too big to send.**
   `components.md` is about 90k tokens and `scene.md` about 10k;
   `llms.txt` is an index of links. No compact primer ships.
2. **Anything timed needs code.** Every tween starts at tick 0 and there is
   no delay, no path or waypoint component, and no "at tick N" for
   entities. Walking two legs, sitting down after arriving, a dog that
   follows: each needs a scene script in JavaScript under Molen's
   determinism rules. Scripts also need `eval` (SES compartments), so they
   cannot run on phones.
3. **Figures only move and sit.** No wave, point, talk, or facial
   animation, no lip sync. Joint overrides exist but need quaternions.
4. **Camera tracks are position and look-at only.** No field of view, no
   follow-an-entity keyframe, no cut (fake it with two keyframes one tick
   apart), no shot list.
5. **Rendering is slow and silent.** `molen frames` uses software rendering
   in headless Chromium: 90 frames of a three-figure scene at 720p took 259
   s (2.9 s a frame, with the probe model running beside it), so a one-minute
   film at 30 fps is over an hour. It writes PNGs only; there is no encoder
   and no audio in captures (`molen audio plan` lists the timed sounds).
   Content-pack models (vehicles, trees) do not appear in headless captures.
6. **No player.** Every sample on molen.dev is its own Vite build. A
   no-build page can mount Molen from published files on the desktop (the
   kernel can run in-page over a `MessageChannel`), but it needs an import
   map of about 13 entries and some 20 lines of boot code a small model
   will get wrong. Module workers get no import map, so the documented
   Worker route fails on Gezel's shelf.
7. **Version mismatch with the shelf.** Molen's three.js peer range is
   0.184 to 0.186; the shelf's module line is 0.187.
8. **Real places are code only.** Earth view is mounted with
   `mountEarthView` in TypeScript; scene JSON has no geographic block, the
   view takes no camera track, and frames come only from wall-clock
   screenshots. Region data is ODbL and must carry its attribution.
9. **Scripts run with the host's authority.** Molen says so plainly: its
   sandbox makes simulation deterministic, it does not contain code. A Molen
   MCP toolset that simulates or renders a model-written scene runs that
   scene's scripts as the person, outside Gezel's script sandbox. Today only
   the bundled DocBlocks toolset is trusted
   ([toolset-trust.ts](../packages/core/src/toolset-trust.ts)).
10. **Games need code for everything that makes them games.** Rules of
    play, touch detection, and score and lives on screen exist only as
    scripts and page code (see the survey under Phase 0), so a game
    inherits every problem in items 2 and 9.

## Proposed path

### 1. Teach and check (Gezel, small)

- One generated primer, owned in one place like `squisqAuthoringNote`
  ([squisq-dialect.ts](../packages/core/src/transform/squisq-dialect.ts)),
  attached when a craftbook step declares `authoring: 'molen-scene'` (or
  `'molen-film'` once it exists). Better still, Molen ships the primer,
  generated from its schemas and versioned with the package, and Gezel
  quotes it.
- Validation in the daemon with `@bendyline/molen-schema` alone: it
  depends only on zod, runs no scene code and needs no browser. Expose it as
  a tool and as a gate check, so a step cannot finish on an invalid scene.
- Looking at the result reuses what the structure-workshop work built
  ([structure-workshop-eval.md](structure-workshop-eval.md)): a render, an
  image read, and the `imageEvidence` gate, for models that can see.

### 2. Raise the level: a film format (Molen)

A small declarative document, for example `molen/film@1`, compiled by Molen
into a scene, a generated cue script or data-only cues, and a camera track:

```json
{ "format": "molen/film@1", "name": "the-meeting", "look": "evening",
  "set": { "ground": "plaza", "props": [ { "id": "fountain", "shape": "cylinder", "size": [3, 0.8, 3], "at": "center" } ] },
  "marks": { "west": [-8, 3], "east": [2, 3] },
  "cast": [
    { "id": "ana", "preset": "human.adult", "colors": { "top": "#c0392b" }, "at": "west" },
    { "id": "ben", "preset": "human.adult", "colors": { "top": "#2e86de" }, "at": "east" } ],
  "beats": [
    { "at": 0, "who": "ana", "do": "walk-to", "target": "ben", "seconds": 4 },
    { "at": 0, "who": "ben", "do": "look-at", "target": "ana" },
    { "at": 5, "who": "ana", "do": "sit" } ],
  "shots": [
    { "at": 0, "kind": "wide", "on": ["ana", "ben"] },
    { "at": 4, "kind": "medium", "on": "ana", "move": "push-in" } ],
  "captions": [ { "at": 1, "seconds": 3, "text": "Saturday, nine o'clock." } ] }
```

What the compiler does that the model should not:

- `walk-to` a person stops at a sensible distance, facing them.
- `look` presets (`morning`, `noon`, `evening`, `night`, `overcast`) set
  sky, sun and exposure so the frame is readable.
- Shot kinds (`wide`, `medium`, `close`, `over-the-shoulder`, `orbit`,
  `push-in`, `follow`) become camera keyframes framed on the subjects'
  bounds; a new shot is a cut.
- Times are seconds, not ticks; positions are marks or 2D ground points;
  no rotations at all.
- The validator checks names (`target: "bne"` has a did-you-mean) and
  reports what a render would show: who is off screen in which shot.

The smallest Molen additions that let the compiled output be pure data, so
it also plays on phones, are: a start delay on `tween`, a waypoint path
component, timed figure-mode cues, and camera keyframes that follow an
entity with a field of view. Without them the compiler emits a generated
script, which works on the desktop only.

A game document sits beside it on the same vocabulary (looks, figures,
shapes):

```json
{ "format": "molen/game@1", "name": "Coin Garden", "kind": "top-down",
  "layout": "garden", "look": "noon",
  "pieces": {
    "P": { "role": "player", "figure": "human.child", "speed": 4 },
    "o": { "role": "pickup", "shape": "sphere", "color": "#ffd166", "count": 5 },
    "x": { "role": "hazard", "figure": "dog", "move": "patrol", "speed": 2 } },
  "win": { "collect": "all" }, "lose": { "lives": 3 },
  "text": { "title": "Coin Garden", "win": "You made it!", "lose": "Try again." } }
```

The compiler draws the level (or reads a text `map` a stronger model
drew), and supplies the camera, keyboard and on-screen controls, the rule
for each role (a pickup scores and disappears, a hazard costs a life, the
goal wins), the score display and restart. For the rules to be data
rather than a generated script, Molen needs one small action list (`set`,
`add`, `spawn`, `destroy`, `emit`, `tween`, `sound`, figure mode) with two
triggers: cues at a time (films) and rules on an event or condition
(games), plus trigger zones in its homegrown physics engines. A bad rule
reports an error; it never stops the world. That takes scripts out of
everything a model writes, which settles three problems at once: scripts
run with the person's authority, scripts need `eval` (no phones), and a
script error is fatal.

### 3. Play and render (Gezel, with a Molen player)

- **Player.** Molen publishes one prebuilt player module,
  `mountScene({ canvas, scene, track })` or `mountFilm(...)`, with the
  kernel in-page, figures wired, and SES loaded only when a scene has
  scripts. Gezel serves it as a desktop page-library line (after the three.js
  ranges agree) and opens `.scene.json` and `.film.json` files in the Output
  pane and file viewer, the way a Squisq document opens in its editor. The
  model writes data only; it never writes boot code.
- **Render to video.** Render in the app, on the GPU: the player's manual
  frame loop steps the kernel a tick at a time and encodes the canvas with
  WebCodecs, so a film renders faster than real time instead of at 2.9 s a
  frame. `molen frames` plus ffmpeg (Gezel's
  [video delivery](../packages/service/src/media/video-delivery.ts)) is the
  headless fallback. Narration comes from Gezel's speech engine, captions
  from the film's `captions`, and timed sound from `molen audio plan`.
- **Craftbooks.** "A 3D scene from a description" and "a short animated
  film" (writes `film.json`, renders, looks at three frames, fixes, renders
  the MP4), each with a test.json eval on small models.

### 4. A Molen toolset, later and narrowly

Molen's MCP server is worth offering to people who build Molen experiences
in a code folder, the way DocBlocks is offered for documents. For small
models the 45 tools need trimming to about five (validate, screenshot,
export frames, get component, list figure presets). It must not run
model-written scripts as the person: either Molen tooling gains a
data-only mode that refuses `scripts`, or the toolset stays untrusted and
behind the script-execution switch.

### 5. Real places, last

Worth doing for "a flyover of Kyoto at sunset" and route animations, but it
needs Molen to accept a geographic camera path as data, capture
deterministic frames from Earth view, and place film cast at a latitude and
longitude. Region data would be a downloaded content kind like knowledge
catalogs, with its ODbL attribution carried into every render.

## Asks for Molen, in order of leverage

1. The film and game formats and their compilers, with the staging rules
   Phase 0 found, generated game layouts (garden, maze, arena, platformer
   level) as the default, and a lint that reports framing (films) and
   whether a game can be won and lost, routing around hazards (games).
2. A compact primer for each, generated from the schemas (about 1.5k
   tokens), shipped in the package. Its examples must differ from what
   books ask for.
3. Rules and cues as data (the action list above), trigger zones in the
   homegrown engines, and a HUD block for score, lives and messages.
4. A prebuilt player module with an in-page link and lazy SES, and a
   camera track a scene can carry inline, so an answer is one document.
5. Data-only choreography: tween delay, waypoint paths, timed figure
   modes, camera follow and field of view.
6. Trap fixes: a `plane` that lies flat as its schema says (or a schema
   that says it stands up), default `ref` for figure renderables, a
   figure's look-at aimed at the target's head rather than its feet
   (`figures/src/kernel/runtime.ts:126`), a quadruped sit pose that does
   not twist, and time-of-day lighting presets.
7. A data-only mode for the tooling (`--no-scripts`).
8. A three.js peer range that includes 0.187, and pack models in headless
   captures.

## Next experiments

1. **Rerun Phase 0 against the real formats.** The same briefs and
   measures, on the formats as built in Molen, plus Qwen 3.8 27B.
2. **A planning bot for platformers.** The reactive bot loses levels a
   person can win, which limits what a play test can say about a level a
   model drew.
3. **Look and fix.** Give a vision-capable model its own render and one
   repair round; measure whether composition improves without the format.
4. **GPU render speed.** Time the in-app WebCodecs path for a one-minute
   film against `molen frames`.

## Open questions

- Should the film format live in Molen (recommended: it gains Molen's
  validator, docs and every other Molen user) or in Gezel?
- Are phones in scope for films, which decides whether data-only
  choreography is required or only nice to have?
- How far into real places should the first version go?
- Are games built from a short list of layouts acceptable for a first
  version? They are what plays at 4B; a drawn `map` stays available to a
  stronger model, refused when the player cannot reach what matters.
- Should Gezel ask for a game document even at 12B and above, where a plain
  page often responds to keys, for the play test, determinism and no
  model-written code?

The probe ran from a scratch folder; its scripts, raw replies and renders are
not kept in the repository, so the tables above are the record.
