/**
 * `gezel app new` — scaffold a minimal, immediately-buildable AI App
 * source folder. The templates live here as string constants so the
 * command works from an installed CLI with no repo checkout and no
 * build-hook-staged assets; a CLI test validates the scaffold with the
 * real `validateGezappSource`, which keeps these constants permanently
 * in sync with the format.
 */

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
const raw = await gezel.fs.read('data.json').catch(() => '{"records":[]}');
const data = JSON.parse(raw) as { records: Array<{ title: string; at: string }> };
if (input.action === 'add' && input.title) {
  data.records.push({ title: input.title, at: new Date().toISOString() });
  await gezel.fs.write('data.json', JSON.stringify(data, null, 2));
}
gezel.output({ records: data.records });
`;

function dashboardHtml(name: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root {
    color-scheme: light dark;
    --bg: #f7f4ee;
    --ink: #2c2925;
    --card: #fffdf9;
    --line: #d9d2c6;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #211e1a;
      --ink: #e8e2d8;
      --card: #2b2723;
      --line: #47413a;
    }
  }
  body {
    margin: 0;
    padding: 1.5rem;
    background: var(--bg);
    color: var(--ink);
    font: 15px/1.5 system-ui, sans-serif;
  }
  h1 { font-size: 1.2rem; margin: 0 0 1rem; }
  ul { list-style: none; margin: 0; padding: 0; }
  li {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
    margin-bottom: 0.5rem;
  }
  button {
    background: var(--card);
    color: var(--ink);
    border: 1px solid var(--line);
    border-radius: 4px;
    padding: 0.4rem 0.9rem;
    cursor: pointer;
  }
</style>
</head>
<body>
<h1>${name}</h1>
<ul id="records"></ul>
<button id="add">Add a record</button>
<script>
  const list = document.querySelector('#records');
  function render(data) {
    list.replaceChildren();
    for (const record of data.records) {
      const item = document.createElement('li');
      item.textContent = record.title + ' — ' + record.at.slice(0, 10);
      list.append(item);
    }
  }
  async function refresh() {
    render(await gezel.data.read('data.json', { as: 'json' }));
  }
  gezel.data.watch('data.json', refresh);
  document.querySelector('#add').addEventListener('click', async () => {
    await gezel.tools.invoke('add_record', { title: 'Added from the page' });
    await refresh();
  });
  refresh();
</script>
</body>
</html>
`;
}

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
          {
            name: 'add_record',
            description: 'Add one record to data.json.',
            script: 'records-store',
            inputs: {
              type: 'object',
              properties: { title: { type: 'string' } },
              required: ['title'],
            },
            bind: { action: 'add' },
          },
        ],
        workspaceSeed: ['data.json'],
        ...(opts?.withPage
          ? {
              pages: {
                entry: 'dashboard/index.html',
                api: 1,
                reads: [{ source: 'workspace', path: 'data.json' }],
                tools: ['add_record'],
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
