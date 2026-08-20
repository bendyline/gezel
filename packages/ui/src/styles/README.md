# UI stylesheet ownership

`../styles.css` is the ordered startup manifest. It contains imports only; do
not add selectors there. Numeric prefixes make the core cascade order visible.
Surface-scoped styles that are imported by a lazy React view are intentionally
absent from the manifest: their CSS arrives in the same chunk as its owner, so
there is no unstyled intermediate render.

| File | Owner |
| --- | --- |
| `00-foundation.css` | Tokens, themes, reset, typography, focus, reduced motion, and document roots |
| `01-app-shell.css` | App notices, title bar, global navigation, meters, overlays, and primary sidebar |
| `02-file-browser.css` | List panes, shared file browser, workspace/index panes, document surfaces, and file previews |
| `03-shared-content.css` | Document export, shared content utilities, core chat bubbles/composer chrome, and Squisq integration |
| `04-gezels.css` | Gezel identity, appearance, roster, and detail surfaces |
| `05-settings-and-status.css` | Settings navigation/panels, machine policy, and project status/index controls |
| `06-history.css` | History master/detail view |
| `07-tasks.css` | Task lists, detail, status controls, step tracker, and phase editor |
| `08-home.css` | Shared article, provider/status, session, and settings recipes |
| `08-home-view.css` | **On demand:** Home workshop, first-run setup, media downloads, and intro surface (owned by `HomeView`) |
| `09-chat.css` | Project chat, tool output, references, timeline, memories, commands, and chat task rail |
| `10-catalog-and-primitives.css` | Engine/model settings, catalog/toolsets, transformation flow, and base Radix primitives |
| `11-project-surfaces.css` | Project output, remaining tab primitives, questions, creation galleries, mail, and connected project surfaces |
| `12-terminal.css` | In-chat terminal, terminal composer, and folder switcher |
| `13-github-and-growth.css` | GitHub workspace and gezel growth surfaces |
| `14-scripts-and-craftbooks.css` | Script editor, craftbook editor, automation, and gates |
| `15-village-and-overview.css` | Village, task planning, project overview, machine budget, and remote serving |
| `16-controls-handbook-and-admin.css` | Late shared control recipes, storage cleanup, backup/restore, and first-run content |
| `16-handbook.css` | **On demand:** Handboek master/detail surface (owned by `HandboekView`) |
| `17-knowledge.css` | **On demand:** Knowledge catalog browser (owned by `KnowledgeView`) |

## Editing rules

- Put a new selector in the file owned by its rendering surface.
- Extend a shared `gz-*` recipe only when more than one surface needs the
  behavior. Keep feature-specific modifiers with their feature.
- Do not reorder manifest imports casually. Several legacy aliases
  intentionally rely on the late keys-in-trays recipe in
  `16-controls-handbook-and-admin.css`.
- Keep on-demand styles surface-scoped. A lazy stylesheet must not define a
  prerequisite for a component that can render before its owning view.
- Avoid cross-file overrides. If a component needs to override a shared recipe,
  use a component-qualified selector in the component's owner file and note the
  dependency in a comment.
- Keep palette values in `00-foundation.css`; component files consume semantic
  variables rather than defining parallel colors.
