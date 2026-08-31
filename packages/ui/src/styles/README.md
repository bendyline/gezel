# UI stylesheet ownership

`../styles.css` is the ordered startup manifest. It contains imports only; do
not add selectors there. The import sequence makes the core cascade order
explicit without encoding that order in filenames. Surface-scoped styles that
are imported by a lazy React view are intentionally absent from the manifest:
their CSS arrives in the same chunk as its owner, so there is no unstyled
intermediate render.

| File | Owner |
| --- | --- |
| `foundation.css` | Tokens, themes, reset, typography, focus, reduced motion, and document roots |
| `app-shell.css` | App notices, title bar, global navigation, meters, overlays, and primary sidebar |
| `file-browser.css` | List panes, shared file browser, workspace/index panes, document surfaces, and file previews |
| `shared-content.css` | Document export, shared content utilities, core chat bubbles/composer chrome, and Squisq integration |
| `gezels.css` | Gezel identity, appearance, roster, and detail surfaces |
| `settings-and-status.css` | Settings navigation/panels, machine policy, and project status/index controls |
| `history.css` | History master/detail view |
| `tasks.css` | Task lists, detail, status controls, step tracker, and phase editor |
| `home.css` | Shared article, provider/status, session, and settings recipes |
| `home-view.css` | **On demand:** Home workshop, first-run setup, media downloads, and intro surface (owned by `HomeView`) |
| `chat.css` | Project chat, tool output, references, timeline, memories, commands, and chat task rail |
| `catalog-and-primitives.css` | Engine/model settings, catalog/toolsets, transformation flow, and base Radix primitives |
| `project-surfaces.css` | Project output, remaining tab primitives, questions, creation galleries, mail, and connected project surfaces |
| `terminal.css` | In-chat terminal, terminal composer, and folder switcher |
| `github-and-growth.css` | GitHub workspace and gezel growth surfaces |
| `diffpacks.css` | Change-proposal review pane (the project Proposals tab) |
| `scripts-and-craftbooks.css` | Script editor, craftbook editor, automation, and gates |
| `village-and-overview.css` | Village, task planning, project overview, machine budget, and remote serving |
| `controls-handbook-and-admin.css` | Late shared control recipes, storage cleanup, backup/restore, and first-run content |
| `squisq-theme.css` | Rebinds the vendored Squisq editor's `--squisq-*` chrome palette onto gezel's tokens |
| `handbook.css` | **On demand:** Handboek master/detail surface (owned by `HandboekView`) |
| `knowledge.css` | **On demand:** Knowledge catalog browser (owned by `KnowledgeView`) |

## Editing rules

- Put a new selector in the file owned by its rendering surface.
- Extend a shared `gz-*` recipe only when more than one surface needs the
  behavior. Keep feature-specific modifiers with their feature.
- Do not reorder manifest imports casually. Several legacy aliases
  intentionally rely on the late keys-in-trays recipe in
  `controls-handbook-and-admin.css`.
- Keep on-demand styles surface-scoped. A lazy stylesheet must not define a
  prerequisite for a component that can render before its owning view.
- Avoid cross-file overrides. If a component needs to override a shared recipe,
  use a component-qualified selector in the component's owner file and note the
  dependency in a comment.
- Keep palette values in `foundation.css`; component files consume semantic
  variables rather than defining parallel colors.
