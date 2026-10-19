/**
 * `gezel app new` — scaffold a minimal, immediately-buildable AI App
 * source folder. The templates live here as string constants so the
 * command works from an installed CLI with no repo checkout and no
 * build-hook-staged assets; a CLI test validates the scaffold with the
 * real `validateGezappSource`, which keeps these constants permanently
 * in sync with the format.
 */

import { dashboardHtml } from './app-scaffold-page.js';

/** Stricter than the catalog id rule: ids become folder names on every OS. */
export const SCAFFOLD_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

export interface ScaffoldOptions {
  /** Display name; defaults to the title-cased id. */
  name?: string;
  /** Include an Output page wired to the example tool and seed. */
  withPage?: boolean;
}

function titleCase(id: string): string {
  return id
    .split('-')
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(' ');
}

function shard(id: string): string {
  return id.slice(0, 2).toLowerCase();
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const STORE_SCRIPT = `import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';

export const meta = defineScript({
  name: 'records-store',
  description: 'Add and list records in data.json.',
  kind: 'action',
  inputs: {
    action: { type: 'string', description: "'add' or 'list'.", default: 'list' },
    title: { type: 'string', description: 'Title for a new record.', default: '' },
  },
  outputs: {
    records: { type: 'json', description: 'The records after the operation.' },
  },
  requires: ['workspace.read', 'workspace.write'],
} as const);

const input = gezel.input as InferredInput<typeof meta>;
// The installer seeds this file. A missing/unreadable file is an error, not an empty store.
const raw = await gezel.fs.read('data.json');
const data = JSON.parse(raw) as { records: Array<{ title: string; at: string }> };
if (!Array.isArray(data.records) || data.records.some(record =>
  !record || typeof record.title !== 'string' || typeof record.at !== 'string')) {
  throw new Error('data.json must contain a records array with title and at strings.');
}
if (input.action === 'add') {
  const title = input.title.trim();
  if (!title) throw new Error('Enter a title for the record.');
  data.records.push({ title, at: new Date().toISOString() });
  await gezel.fs.write('data.json', JSON.stringify(data, null, 2));
}
gezel.output({ records: data.records });
`;

/**
 * Render the scaffold as `[source-root-relative path, content]` pairs.
 * Pure — the command layer owns all filesystem writes.
 */
export function scaffoldGezappSource(
  id: string,
  opts?: ScaffoldOptions,
): Array<[rel: string, content: string]> {
  if (!SCAFFOLD_ID_PATTERN.test(id)) {
    throw new Error(
      `"${id}" is not a valid app id — use lowercase letters, digits, and hyphens (2-64 chars)`,
    );
  }
  const name = opts?.name ?? titleCase(id);
  const roleId = `${id}-lead`;
  const typeDir = `items/project-types/${shard(id)}/${id}`;
  const roleDir = `items/gezel-templates/${shard(roleId)}/${roleId}`;
  // A name in pages.tools is deliberately excluded from the model roster.
  // Both audiences use the same implementation through separate aliases.
  const addRecord = {
    description: 'Add one record to data.json.',
    script: 'records-store',
    inputs: {
      type: 'object',
      properties: { title: { type: 'string', minLength: 1 } },
      required: ['title'],
    },
    bind: { action: 'add' },
  };

  const files: Array<[string, string]> = [
    [
      'gezapp.json',
      json({
        format: 'gezel-ai-app-source',
        schemaVersion: 1,
      }),
    ],
    [
      'README.md',
      `# ${name}

An AI App source folder scaffolded by \`gezel app new\`.

The loop:

1. Edit the files under \`items/\` (schemas: \`gezel app schemas --out schemas\`).
2. \`gezel app validate .\`
3. \`gezel app pack .\`
4. \`gezel app add ${id}-1.0.0.gezapp --yes\` then \`gezel app apply ${id}\` in a project folder.

The keeper uses \`add_record\` to update the seeded \`data.json\` through
\`records-store\`. Read failures are errors; they never reset existing data.
${
  opts?.withPage
    ? `
Open \`${typeDir}/versions/1.0.0/pages/dashboard/index.html\` directly to try
the standalone demo. Sample records stay in memory; **Reset demo** restores them.
Inside Gezel the same page uses real project data and the page-only
\`page_add_record\` alias. Names in \`pages.tools\` are excluded from the gezel's
tool roster, so keep its \`add_record\` alias separate. Both call \`records-store\`.
The browser preview is read-only; embedded and shared-site modes can run actions
when the host permits them. A host error never switches the page to demo data.

Fonts come from Gezel's injected \`--font-body\`, \`--font-ui\`, and
\`--font-heading\` variables; raw-file demos use system fallbacks. Do not bundle
font files. The page owns its layout/colors, follows host theme updates, and
unsubscribes from theme/file watches on teardown. Use explicit button/keyboard
handlers: the embedded sandbox blocks native form submissions.
`
    : ''
}
Authoring references:

- [Building Gezel apps](https://github.com/bendyline/gezel/blob/main/docs/building-gezel-apps.md)
- [Page APIs](https://github.com/bendyline/gezel/blob/main/docs/output-pane-api.md)
- [Page style guide](https://github.com/bendyline/gezel/blob/main/docs/handboek/technical/gezel-app-page-style-guide.md)
`,
    ],
    [
      `${typeDir}/manifest.json`,
      json({
        schemaVersion: 1,
        kind: 'project-type',
        id,
        name,
        description: `A focused ${name} workspace with one gezel and a records store.`,
        tags: [],
        maintainer: { name: 'Your name' },
        license: 'MIT',
        yankedVersions: [],
      }),
    ],
    [
      `${typeDir}/versions/1.0.0/manifest.json`,
      json({
        schemaVersion: 1,
        version: '1.0.0',
        releasedAt: new Date().toISOString(),
        mode: 'solo',
        leadLabel: 'Keeper',
        params: {
          type: 'object',
          properties: {
            focus: {
              type: 'string',
              title: 'What is this workspace about?',
              default: 'everyday records',
            },
          },
        },
        nameTemplate: `{{focus}} ${name}`,
        aboutTemplate: 'about.md',
        missionTemplate: 'mission.md',
        gezels: [{ templateId: roleId, voorman: true }],
        tools: [
          { name: 'add_record', ...addRecord },
          ...(opts?.withPage ? [{ name: 'page_add_record', ...addRecord }] : []),
        ],
        workspaceSeed: ['data.json'],
        ...(opts?.withPage
          ? {
              pages: {
                entry: 'dashboard/index.html',
                api: 1,
                reads: [{ source: 'workspace', path: 'data.json' }],
                tools: ['page_add_record'],
              },
            }
          : {}),
      }),
    ],
    [
      `${typeDir}/versions/1.0.0/about.md`,
      `This project is a ${name} workspace focused on {{focus}}.

Records live in data.json; use the add_record tool rather than editing it by hand.
`,
    ],
    [
      `${typeDir}/versions/1.0.0/mission.md`,
      `- Keep data.json accurate and current.
- Add a record whenever the user mentions something worth keeping.
`,
    ],
    [`${typeDir}/versions/1.0.0/data.json`, json({ records: [] })],
    [`${typeDir}/versions/1.0.0/scripts/records-store.ts`, STORE_SCRIPT],
    [
      `${roleDir}/manifest.json`,
      json({
        schemaVersion: 1,
        kind: 'gezel-template',
        id: roleId,
        name: `${name} Keeper`,
        description: `The resident keeper of a ${name} workspace.`,
        role: 'Keeper',
        tags: [],
        maintainer: { name: 'Your name' },
        license: 'MIT',
        yankedVersions: [],
      }),
    ],
    [
      `${roleDir}/versions/1.0.0/manifest.json`,
      json({
        schemaVersion: 1,
        version: '1.0.0',
        releasedAt: new Date().toISOString(),
        about: 'about.md',
      }),
    ],
    [
      `${roleDir}/versions/1.0.0/about.md`,
      `You are the keeper of this ${name} workspace.

Working style: short, warm answers. When the user mentions something worth keeping, add it with the add_record tool and confirm in one line. Never edit data.json by hand.
`,
    ],
  ];
  if (opts?.withPage) {
    files.push([`${typeDir}/versions/1.0.0/pages/dashboard/index.html`, dashboardHtml(name)]);
  }
  return files;
}
