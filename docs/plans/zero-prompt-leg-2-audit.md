# Zero-prompt leg 2: starter launch audit

Catalog: /Users/mike/gh/gilde/data.
Generated with `GEZEL_GILDE_DATA_DIR=/Users/mike/gh/gilde/data pnpm --filter @bendyline/gezel-catalog exec tsx scripts/audit-starter-launches.ts --out ../../docs/plans/zero-prompt-leg-2-audit.md`.

| Plan | Version | Main field | Visible fields | Required inputs | Optional pickers | Raw path fields | Effective path fields | Eval mode |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| narrated-slideshow | 1.1.8 | topic | topic | none | none | none | none | workflow |
| branding-website | 1.1.4 | topic | topic | none | none | none | none | workflow |
| research-report | 1.0.4 | topic | topic | none | none | none | none | workflow |
| report-pdf | 1.1.8 | topic | topic | none | none | none | none | workflow |
| powerpoint-deck | 1.7.18 | topic | topic, content, audience | none | sourcePath | none | none | workflow |
| research-to-document | 1.2.8 | topic | topic | none | none | none | none | workflow |

## Selection and compatibility

The audited catalog contains six tagged starters. All accept a topic as their
main content and require no source file. PowerPoint additionally offers an
optional file picker and optional pasted material/audience. Output paths are
derived from the task or explicitly hidden. The catalog contract fails on a
starter path field and reports other plans without failing them.

The unchanged application pin (Gilde 0.1.93) does not yet carry these tags.
The app uses the six known ids only when the entire catalog has no starter tag,
then intersects that set with the project's applicable plans. This distinction
prevents a project filter from accidentally restoring an excluded fallback.
Older starters without a topic parameter receive the brief in the task
description. The legacy PowerPoint source text box is omitted until its
catalog declares the supported picker. Derived fields are hidden only in these
legacy starter forms; general plans retain their existing visibility rules.

Pre-change observations: five seeds lacked a main content parameter;
PowerPoint exposed raw output/source path fields; only PowerPoint and Website
had full workflow coverage selected. Word exercised a direct worker with a
binary fixture, while PDF and slideshow stopped at Markdown checks. Each seed
now has a new unpublished version and a full workflow sidecar. Reliability
results are tracked in [the eval report](zero-prompt-leg-2-evals.md).

The Home row respects project applicability, so an established codebase can
have fewer than six cards (for example, Website is a project starter). The
most recently visited project is used; before one has been visited, the destination is
Default. Hidden tool requirements still block launch with their setup controls.

Catalog-wide example images and estimates remain deferred as planned. W7
(project overview starts and suggestions in more chat contexts) remains out of
scope for this pass.

## Implementation map

| Workstream | Changed files |
| --- | --- |
| W0 audit | `packages/catalog/scripts/audit-starter-launches.ts`; this report |
| W1 form contract | `packages/core/src/starter-craftbooks.ts` and tests; `packages/catalog/src/starter-launch-contract.test.ts`; six new Gilde versions |
| W2 starter selection and launch | `packages/service/src/http/routes/projects.ts`, `projects.starter-offer.test.ts`; `packages/client/src/client.ts`; `packages/ui/src/views/tasks/NewTaskDialog.tsx`, its tests and `plan-launch.css`; core browser export |
| W3 Home | `packages/ui/src/views/home/MakeSomething.tsx`, its tests and `make-something.css`; `HomeWorkshop.tsx`, `utils.ts`; shared mock API defaults; `packages/app/e2e-web/starter-launch.spec.ts`, `tasks.spec.ts`, screenshot registry |
| W4 words | `packages/ui/src/components/ChatComposer.tsx`, `ComposerTaskBar.tsx`, `composer-task-launch.ts`; `views/tasks/new-task-meta.ts`; `docs/ux.md` |
| W5 outputs and timing | core starter helpers and service offer metadata; launch/gallery previews |
| W6 evals | `packages/core/src/schemas/craftbook-test.ts`; `evals/src/fixtures/media.ts`; mock server and tests; model source/cache freshness and tests; craftbook coverage notes; Gilde sidecars and exported schemas |

The first full research diagnostic also exposed misleading runtime routing
guidance: omitting `next` follows a configured repair loop, not necessarily the
following step. Corrections are in core's `tools/inputs/tasks.ts`,
`tools/gezel-tool-descriptions.ts`, `tasks/step-routing.ts`,
`tasks/prompt-context.ts` and its tests, and the full tool-cookbook behavior.
The reviewer still must explicitly select the successful branch; no acceptance
gate or safe default was weakened.

New Gilde versions (unpublished): Research report `1.0.4`, Word document
`1.2.8`, Slide deck `1.7.18`, PDF report `1.1.8`, Website `1.1.4`, Animated
slideshow `1.1.8`. Their identities carry the `starter` tag. The app's pin is
unchanged; the implementation supports that older catalog while the owner
handles publication.

## Validation

- Core launch/starter tests: 43 passed. Routing/input/prompt regression tests:
  98 passed.
- Catalog starter contract: passed against both the pinned catalog and the
  sibling catalog. Non-starter path findings are warnings as designed.
- Service starter-offer route: 2 passed. The routing follow-up passed 51
  service prompt/golden/offer integration tests.
- UI Home/dialog/composer coverage: 96 passed; the subsequent project-switch
  regression passed in a focused 34-test run.
- Eval craftbook/mock/cache suite: 285 passed, 1 skipped. Focused model source
  and cache suite: 47 passed, 1 skipped.
- Browser Home launch and Tasks flows: 3 passed. The Home flow needs two clicks
  plus the topic; screenshot: `packages/app/ux-screenshots/home/04-research-quick-launch.png`.
- Repository-wide typecheck passed again after the routing follow-up.
  Changed-file Biome checks passed. Core, client, MCP, UI and service builds
  passed.
- Gilde validation: 0 errors and 0 warnings across 34,357 files. Indexes and
  schema exports regenerated. Strict craftbook quality coverage passed:
  all 288 parameter contracts clean, no unreachable declared deliverables.

These checks establish launch behavior and deterministic eval plumbing. The
2-of-3 reliability gate on both local models is still pending; consult the
continuously updated eval report for measured results. Binary media fixtures
exercise orchestration and container validity; native conversion and visual
quality still need a separate smoke test.
