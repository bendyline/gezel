# Gezel app platform review — October 2026

This is an implementation-based review after building Data Analysis and Media
Library. Recommendation 1 is implemented; recommendations 2–6 remain proposals. The
[authoring entry point](building-gezel-apps.md) describes what authors can use now.

## Keep the composition model

The strongest part of the platform is that one experience can combine an ordinary
folder, a tailored page, named gezellen, repeatable craftbooks, and deterministic
actions. A gallery can use only the page and folder. A trainer can add a role and
state transitions. A reporting app can add a query-backed view and a review
craftbook. This scales by composing the same primitives rather than adding a
custom native screen for every app.

Keep the separation between type-owned presentation and user-owned files. Keep
the permission checks on the host, and keep actions auditable through declared
tools. The shared file/rendition/table APIs and typography are the right direction.
Avoid making apps depend on the daemon's internal endpoints or file layout.

## Recommended order of work

| Priority | Improvement | Why it matters / completion criterion |
| --- | --- | --- |
| 1 — implemented | Make the scaffold the reference implementation | New pages inherit fonts and include live/demo handling, theme updates, cleanup, failure states, and separate page/model tool aliases. Contract and browser tests exercise the generated app and installed actions. |
| 2 | Add one app development command | Watch source files, validate, reload an isolated project preview, and display page/API diagnostics. Offer explicit demo and real-host modes. An author should not need repeated pack/add/apply cycles merely to change CSS. |
| 3 | Finish the shared page design contract | Version a small set of semantic color/spacing/radius tokens and optional control styles beside fonts, with standalone preview parity. Avoid shipping the entire shell stylesheet or a mandatory component framework. |
| 4 | Expose capabilities and data readiness explicitly | Let a page discover supported operations, limits, indexing status, and query availability. Distinguish no data, indexing in progress, permission denial, unsupported host, and a missing engine without probing through errors. |
| 5 | Make updates safe for app state and local edits | Define data versions, explicit migrations, backup/rollback, and reconciliation for scripts, craftbooks, and seeds. Show an update plan before replacing edited content. |
| 6 | Test the whole composition as one app | Run page actions, role tool calls, craftbook gates, permissions, and upgrade fixtures from one declared app test entry point. Support installed `.gezapp` craftbook tests as well as catalog scenarios. |

### Evidence behind the priorities

The [CLI scaffold](../packages/cli/src/app-scaffold.ts) now consumes shared font
roles and embeds Gilde's canonical standalone demo stub. It exposes `add_record`
to the keeper and `page_add_record` to the page, sharing one script. Its generated
page handles themes, subscriptions, loading/empty/error states, read-only browser
previews, and pending actions. The store script propagates read failures rather
than replacing unreadable data with an empty store. The
[contract tests](../packages/cli/src/app-scaffold.test.ts) guard the canonical
stub and tool audiences, while [browser tests](../packages/app/e2e-web/app-scaffold.spec.ts)
run the generated HTML with the real page shim, shared CSS, sandbox permissions,
and a temporary service installation. Page and named MCP actions both update the
same seeded file; undeclared reads and the wrong tool audience are rejected.
Run `pnpm test:e2e:scaffold` for that focused browser suite.

The current [authoring command loop](handboek/technical/building-ai-apps-inside-gezel.md)
has good schema export and collect-all validation, but source changes still move
through packing, installation, and adoption to exercise a real host. Gilde's
standalone demo server is useful for presentation work; it cannot verify live
permissions or engine integration. A development command should expose both.

The [injected page CSS](../packages/ui/src/assets/fonts/page-defaults.css) supplies
font families only. Each app still writes colors, reset rules, controls, and
responsive states. Documenting this boundary prevents false assumptions;
extending it with a small stable theme contract would reduce repeated work.

The [page shim](../packages/core/src/project-types/page-api-shim.ts) offers several
host modes with different capabilities. New methods such as `data.open` and
`tables` are additive under API version 1, so authors must feature-detect methods
and then handle unavailable engines. The
[table API](output-pane-api.md#querying-tables) queries indexed snapshots; no tables
can mean either no suitable data or an index/engine that is not ready. A supported
capability/readiness envelope would make better UI straightforward.

The existing [source validator](../packages/service/src/project-type/gezapp-source.ts)
and [sample integration tests](../packages/service/src/project-type/examples-apps.test.ts)
are a strong base for app-level verification. Extend them with behavioral tests
for the page and crew together, rather than treating valid manifests or demo
screenshots as evidence of a working app.

## Further improvements after those foundations

- Add bounded recursive file discovery, pagination, cancellation, and a change
  feed so each explorer does not rebuild scanning, watch management, and stale
  response handling. Retain the same `pages.reads` boundary.
- Add optional thumbnail/metadata APIs for large photo libraries. Lazy-loading
  original images is a useful first version, but it still decodes full files.
  Keep caches derived, outside the user's original folder, and permission-scoped.
- Offer parameterized query values and cancellation on the existing restricted
  table API. Keep identifiers explicit and preserve the current parser, source
  authorization, resource bounds, and external-access restrictions.
- Add a permission review that explains the composition in plain language:
  which folders the page reads, what actions can change, which tools leave the
  device, and which schedules will run. Build on existing consent gates rather
  than introducing a second policy system inside apps.
- Make project-to-source export reconcile actual project customizations with the
  installed definition. The current exporter packages the definition; it is not
  a general capture of a project's evolved app.

## Documentation maintenance

The public authoring guide, page API introduction, and page style guide now have
one repository entry point, linked from `AGENTS.md` and `CLAUDE.md`. Keep API
signatures in the reference and generated SDK types, not copied into every
catalog guide. Add documentation checks alongside changes to the scaffold,
injected styles, and host capabilities.

There is a separate maintenance issue: the long `AGENTS.md` and `CLAUDE.md`
engineering guides have diverged beyond app authoring, including service-hosting
descriptions. Consolidating them into one authoritative guide with thin tool
entry points would prevent competing instructions. This review adds the same
app-authoring entry point to both; it does not attempt a general architecture-doc
rewrite.
