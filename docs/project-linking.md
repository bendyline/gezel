# Project linking

Project linking lets work in one project deliberately draw on another
project's knowledge and text workspace without adding a second family of model
tools.

Links are configured in the active project's Settings panel. A newly created
project has no links. Selecting project B while editing project A stores a
one-way A → B link. It does not create B → A, and links are not followed
transitively. This keeps the resulting authority visible in the one settings
screen where it was granted.

## What a link grants

An A → B link has two effects:

1. `search` and proactive indexed-context retrieval search A, B, and the
   shared documents library. Results retain their owning project and linked
   workspace results use a `../B/...` display path.
2. The existing workspace file tools can address B through the virtual path
   `../<project-id>/<path>`. For example, `read_file` can read
   `../vehicle-physics/src/suspension.ts`, while `write_file`, surgical edits,
   directory creation, rename, and delete operate on that same namespace.

Project ids are used instead of display names because ids are unique and
stable across renames. A model can call `list_dir` with `..` to list the
currently linked project ids. A rename cannot cross project boundaries; copy
content explicitly when a file needs to move between projects.

Shared documents use the same retrieval idea but remain implicit: they are
searched for every project and continue to use `list_documents`,
`read_document`, and `write_document`. The shared-library project is not an
explicit link target.

## Security boundary

The `../` syntax exists only inside Gezel's MCP workspace facade. It is parsed
before a filesystem path is constructed, and literal traversal is never
forwarded to either project's on-disk resolver. The daemon independently
checks that:

- the session is bound to source project A;
- A directly links to the requested target B;
- the request carries A as its linked-workspace provenance; and
- the route is on the file-only linked-workspace allowlist.

This allowance covers workspace listing, text reads, bounded batch reads,
text writes, surgical edits, mkdir, same-project rename, delete, stat, and raw
file download. It does not grant access to B's tasks, artifacts, project
settings, terminals, execution routes, git administration, or raw binary
upload. A model still uses `search` to discover relevant indexed content and
the ordinary file tools to inspect or edit exact source text.

B remains the authority for its own writes. If B's managed workspace write
policy is Deny, a gezel working from A may search and read B but cannot mutate
it. Removing the link revokes subsequent linked search and file requests;
deleting B also prunes the stored link from A.

## Deliberate constraints

- Maximum 32 direct links per project.
- No self-links, duplicates, missing targets, or explicit shared-library
  links.
- Archived linked projects remain usable if they were linked before archival,
  but archived projects are hidden from the picker for new links.
- Project links do not expand team/orchestration authority.
- Search citations always retain the owning project so same-named files from
  multiple corpora remain distinguishable.
