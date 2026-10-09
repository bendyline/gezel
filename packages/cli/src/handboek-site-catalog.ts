import {
  CRAFTBOOK_CATEGORY_FAMILY_META,
  CRAFTBOOK_CATEGORY_META,
  resolveCraftbookCategory,
} from '@bendyline/gezel';
import type {
  CatalogItemSummary,
  CatalogKind,
  ChatModelManifest,
  ConnectorTypeManifest,
  CraftbookTemplateManifest,
  GezelTemplateManifest,
  HandboekTocEntry,
  HandboekTocSubcategory,
  ImageModelManifest,
  ProjectTypeManifest,
  ToolsetManifest,
  VideoModelManifest,
} from '@bendyline/gezel';

/**
 * The public catalog pages that gezelgilde.com used to serve, rendered into
 * the gezel.com Handboek export instead: every model, the add-on toolsets and
 * connectors, every role template, and each project type's page demo.
 *
 * Site-only on purpose. The app already browses all of this natively (model
 * settings, the toolset browser, New Gezel), so these pages stay out of the
 * engine — and therefore out of the in-app Handboek and its committed `.gezk`
 * archive.
 */

export interface SiteCatalogSource {
  list(kind: CatalogKind): Promise<CatalogItemSummary[]>;
  listItemFiles(kind: CatalogKind, id: string): Promise<string[]>;
  readItemFile(
    kind: CatalogKind,
    id: string,
    relPath: string,
    sourceId?: string,
    version?: string,
  ): Promise<Buffer | null>;
}

export interface SiteCatalogPage {
  entry: HandboekTocEntry;
  markdown: string;
  /**
   * Listed pages join their area's navigation. Per-model pages are reached
   * from the model table instead: 63 sidebar links would push the Technical
   * area past the inline limit and collapse its navigation on every page.
   */
  listed: boolean;
  /**
   * Replaces the engine's article of the same id on the site instead of
   * adding a page. Its TOC entry stays the engine's.
   */
  replaces?: boolean;
  /** Raw HTML appended after the rendered markdown, for layouts markdown cannot draw. */
  html?: string;
}

export interface SiteDemo {
  projectTypeId: string;
  /** Demo entry path relative to the demo folder, e.g. `dashboard/index.html`. */
  entry: string;
  files: Array<{ path: string; bytes: Buffer }>;
}

export interface SiteCatalog {
  pages: SiteCatalogPage[];
  demos: SiteDemo[];
  /** Woodcut artwork per craftbook id, written beside each craftbook page as `logo.webp`. */
  craftbookArt: Map<string, Buffer>;
}

export const CRAFTBOOK_ART_FILE = 'logo.webp';

export const MODEL_CATALOG_ID = 'model-catalog';
export const TOOLSET_CATALOG_ID = 'toolset-catalog';
export const ROLE_CATALOG_ID = 'role-catalog';

const MODELS_AND_TESTING: HandboekTocSubcategory = {
  id: 'models-and-testing',
  title: 'Models and Testing',
  order: 4,
};
const HOW_GEZEL_WORKS: HandboekTocSubcategory = {
  id: 'how-gezel-works',
  title: 'How Gezel works',
  order: 1,
};

/** Where each engine block in a chat-model manifest runs, in reader terms. */
const ENGINE_LABELS: Array<[keyof ChatModelManifest, string]> = [
  ['llamaCpp', 'llama.cpp'],
  ['mlx', 'MLX'],
  ['ollama', 'Ollama'],
  ['ds4', 'DwarfStar'],
];

const CATEGORY_LABELS: Record<string, string> = {
  general: 'Everyday work',
  reasoning: 'Reasoning',
  coding: 'Coding',
};

export async function buildSiteCatalog(catalog: SiteCatalogSource): Promise<SiteCatalog> {
  const manifests = async <T>(kind: CatalogKind): Promise<T[]> =>
    (await catalog.list(kind)).map((s) => s.manifest as T);

  const chat = (await manifests<ChatModelManifest>('chat-model')).sort(
    (a, b) => (b.recoScore ?? -1) - (a.recoScore ?? -1) || a.name.localeCompare(b.name),
  );
  const images = (await manifests<ImageModelManifest>('image-model')).sort(byName);
  const videos = (await manifests<VideoModelManifest>('video-model')).sort(byName);
  // The toolset listing also carries the ~13,000 community servers and the
  // built-in groups; the Tools and toolsets article already covers the latter.
  const toolsets = await catalog.list('toolset');
  const addOns = toolsets
    .filter((s) => s.sourceId !== 'community' && s.sourceId !== 'builtin')
    .map((s) => s.manifest as ToolsetManifest)
    .sort(byName);
  const communityCount = toolsets.filter((s) => s.sourceId === 'community').length;
  const connectors = (await manifests<ConnectorTypeManifest>('connector-type')).sort(byName);
  const roles = (await manifests<GezelTemplateManifest>('gezel-template')).sort(byName);
  const projectTypes = await manifests<ProjectTypeManifest>('project-type');
  const craftbooks = (await manifests<CraftbookTemplateManifest>('craftbook-template')).sort(
    byName,
  );
  const craftbookArt = new Map<string, Buffer>();
  for (const book of craftbooks) {
    // Only the one file name the catalog publishes, so a malformed manifest
    // cannot pull an arbitrary item file onto the site.
    if (book.logo !== CRAFTBOOK_ART_FILE) continue;
    const bytes = await catalog.readItemFile('craftbook-template', book.id, CRAFTBOOK_ART_FILE);
    if (bytes) craftbookArt.set(book.id, bytes);
  }
  const roleAbouts = new Map<string, string>();
  for (const role of roles) {
    if (!role.about) continue;
    const bytes = await catalog.readItemFile(
      'gezel-template',
      role.id,
      role.about,
      undefined,
      role.version,
    );
    if (bytes) roleAbouts.set(role.id, bytes.toString('utf8'));
  }

  const pages: SiteCatalogPage[] = [
    {
      entry: {
        id: MODEL_CATALOG_ID,
        title: 'Every model',
        area: 'technical',
        order: 14,
        summary:
          'Every AI model Gezel can run on your own computer, with size, context and license.',
        generated: true,
        subcategory: MODELS_AND_TESTING,
      },
      markdown: modelCatalogMarkdown(chat, images, videos),
      listed: true,
    },
    ...chat.map((m) => ({
      entry: {
        id: `model/${m.id}`,
        title: m.name,
        area: 'technical' as const,
        order: 100,
        summary: firstSentence(m.description),
        generated: true,
        subcategory: MODELS_AND_TESTING,
      },
      markdown: chatModelMarkdown(m),
      listed: false,
    })),
    {
      entry: {
        id: TOOLSET_CATALOG_ID,
        title: 'Add-on toolsets and connectors',
        area: 'technical',
        order: 4.5,
        summary:
          'Toolsets you can add to a gezel, and connectors that bring outside data into a project.',
        generated: true,
        subcategory: HOW_GEZEL_WORKS,
      },
      markdown: toolsetCatalogMarkdown(addOns, connectors, communityCount),
      listed: true,
    },
    {
      entry: {
        id: ROLE_CATALOG_ID,
        title: 'Every role template',
        area: 'gezel-roles',
        order: 1,
        summary: 'Ready-made characters you can add to your crew, from researcher to meal planner.',
        generated: true,
      },
      markdown: roleCatalogMarkdown(roles),
      listed: true,
    },
    ...roles.map((r) => ({
      entry: {
        id: `role-template/${r.id}`,
        title: r.name,
        area: 'gezel-roles' as const,
        order: 100,
        summary: firstSentence(r.description),
        generated: true,
      },
      markdown: roleTemplateMarkdown(r, roleAbouts.get(r.id)),
      listed: false,
    })),
    {
      entry: {
        id: 'craftbooks-index',
        title: 'Every craftbook',
        area: 'craftbooks',
        order: 0,
        generated: true,
      },
      markdown: [
        '# Every craftbook',
        '',
        `Craftbooks are step-by-step plans your crew follows to produce a real piece of work. Each one names its steps, who runs them, and the checks the result must pass. There are ${craftbooks.length} of them, grouped here by the kind of work they do.`,
      ].join('\n'),
      html: craftbookGalleryHtml(craftbooks, craftbookArt),
      listed: false,
      replaces: true,
    },
  ];

  const demos: SiteDemo[] = [];
  for (const pt of projectTypes) {
    const demo = await projectTypeDemo(catalog, pt);
    if (demo) demos.push(demo);
  }
  return { pages, demos, craftbookArt };
}

function modelCatalogMarkdown(
  chat: ChatModelManifest[],
  images: ImageModelManifest[],
  videos: VideoModelManifest[],
): string {
  const lines = [
    '# Every model',
    '',
    'These are all the AI models in Gezel’s catalog. Each one runs on your own computer through an engine Gezel installs for you, and Gezel recommends the ones that fit your hardware when you set it up. The [model scorecard](model-scorecard) shows how the models we test actually do on real jobs, and [Local models and tiers](local-models-and-tiers) explains how to choose.',
    '',
    `## Chat models (${chat.length})`,
    '',
    'The models your gezels think and write with, recommended first.',
    '',
    '| Model | Size | Context | Tools | Best for | Runs on | License |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...chat.map((m) =>
      row([
        `[${cell(m.name)}](model/${m.id})`,
        formatGB(m.approxSizeBytes),
        formatContext(m.contextWindow),
        m.supportsTools === false ? 'No' : 'Yes',
        CATEGORY_LABELS[m.category ?? ''] ?? '',
        engines(m).join(', '),
        cell(m.licenseShortName ?? m.license ?? ''),
      ]),
    ),
  ];
  if (images.length > 0) {
    lines.push(
      '',
      `## Image models (${images.length})`,
      '',
      'Models your crew can use to draw pictures, icons and illustrations.',
      '',
      '| Model | Size | Memory needed | Commercial use | License |',
      '| --- | --- | --- | --- | --- |',
      ...images.map((m) =>
        row([
          link(m.name, m.upstream),
          formatGB(m.approxSizeBytes),
          m.minRamGB ? `${m.minRamGB} GB` : '',
          yesNo(m.commercialUse),
          cell(m.licenseShortName ?? m.license ?? ''),
        ]),
      ),
    );
  }
  if (videos.length > 0) {
    lines.push(
      '',
      `## Video models (${videos.length})`,
      '',
      'Models that turn a prompt or a picture into a short clip.',
      '',
      '| Model | Size | Longest clip | Graphics memory needed | Commercial use | License |',
      '| --- | --- | --- | --- | --- | --- |',
      ...videos.map((m) =>
        row([
          link(m.name, m.upstream),
          formatGB(m.approxSizeBytes),
          m.maxDurationSeconds ? `${m.maxDurationSeconds} s` : '',
          m.minVramGB ? `${m.minVramGB} GB` : '',
          yesNo(m.commercialUse),
          cell(m.licenseShortName ?? m.license ?? ''),
        ]),
      ),
    );
  }
  return lines.join('\n');
}

function chatModelMarkdown(m: ChatModelManifest): string {
  // `maker` names who trained the model; `maintainer` who published this build.
  const maker = (m as { maker?: { name?: string } }).maker?.name ?? m.maintainer?.name;
  const facts: Array<[string, string]> = [
    ['Made by', maker ?? ''],
    ['Download size', formatGB(m.approxSizeBytes)],
    ['Parameters', m.parameterSize ?? ''],
    ['Quantization', quantization(m)],
    ['Context window', m.contextWindow ? `${formatContext(m.contextWindow)} tokens` : ''],
    ['Uses tools', m.supportsTools === false ? 'No' : 'Yes'],
    ['Best for', CATEGORY_LABELS[m.category ?? ''] ?? ''],
    ['Runs on', engines(m).join(', ')],
    ['License', m.licenseShortName ?? m.license ?? ''],
    ['Added to the catalog', m.releasedAt ? m.releasedAt.slice(0, 10) : ''],
  ];
  const lines = [
    `# ${m.name}`,
    '',
    m.description.trim(),
    '',
    '| At a glance | |',
    '| --- | --- |',
    ...facts.filter(([, v]) => v).map(([k, v]) => row([k, cell(v)])),
    '',
    'Gezel downloads this model the first time a gezel needs it, checks the file against its published hash, and applies tuned settings for it.',
  ];
  const more = [
    m.upstream ? `[The model’s own page](${m.upstream})` : '',
    '[Every model](model-catalog)',
    '[Model scorecard](model-scorecard)',
  ].filter(Boolean);
  lines.push('', more.join(' · '));
  return lines.join('\n');
}

function toolsetCatalogMarkdown(
  addOns: ToolsetManifest[],
  connectors: ConnectorTypeManifest[],
  communityCount: number,
): string {
  const lines = [
    '# Add-on toolsets and connectors',
    '',
    'Every gezel starts with the built-in tool groups that fit its role, described in [Tools and toolsets](tools-and-toolsets). This page lists what you can add on top.',
  ];
  if (addOns.length > 0) {
    lines.push(
      '',
      '## Add-on toolsets',
      '',
      'Extra tools from Gezel’s own catalog. Add one to a gezel from its Toolsets tab.',
      '',
      '| Toolset | What it does |',
      '| --- | --- |',
      ...addOns.map((t) => row([cell(t.name), cell(firstSentence(t.description) ?? '')])),
    );
  }
  if (connectors.length > 0) {
    lines.push(
      '',
      '## Connectors',
      '',
      'Connectors copy data from outside services, such as mail, calendars and issue trackers, into a project as searchable files. Your crew works on that local copy, never on the live account.',
      '',
      '| Connector | What it brings in |',
      '| --- | --- |',
      ...connectors.map((c) => row([cell(c.name), cell(firstSentence(c.description) ?? '')])),
    );
  }
  if (communityCount > 0) {
    lines.push(
      '',
      '## Community servers',
      '',
      `Gezel’s toolset browser also lists about ${roundDown(communityCount).toLocaleString('en-US')} MCP servers from the public community registry, marked **Community**. They are third-party projects, so review one before you add it to a crew. You can also bring your own: see [Custom MCP toolsets](tools-and-toolsets#custom-mcp-toolsets).`,
    );
  }
  return lines.join('\n');
}

function roleCatalogMarkdown(roles: GezelTemplateManifest[]): string {
  return [
    '# Every role template',
    '',
    'A role template is a ready-made character for your crew: a name, a job, and a working style that shapes how they think and talk. The Meester picks from these when it builds a crew, and you can add any of them yourself with **New Gezel**. The core roles each have their own page in [Roles](roles-index).',
    '',
    '| Role | What they do |',
    '| --- | --- |',
    ...roles.map((r) =>
      row([`[${cell(r.name)}](role-template/${r.id})`, cell(firstSentence(r.description) ?? '')]),
    ),
  ].join('\n');
}

function roleTemplateMarkdown(r: GezelTemplateManifest, about: string | undefined): string {
  const lines = [`# ${r.name}`, '', r.description.trim()];
  if (r.meesterCandidate) {
    lines.push('', 'This character can also act as your Meester, the gezel who runs the crew.');
  }
  if (about?.trim()) {
    lines.push(
      '',
      '## How they work',
      '',
      'This is the character brief Gezel gives the model, word for word. It shapes how this gezel thinks, works and talks.',
      '',
      demoteHeadings(about.trim()),
    );
  }
  lines.push('', '[Every role template](role-catalog) · [Roles](roles-index)');
  return lines.join('\n');
}

/** Keep a brief's own headings below the page's h2, so it cannot add a second title. */
function demoteHeadings(markdown: string): string {
  return markdown.replace(
    /^(#{1,4})(\s)/gm,
    (_, hashes: string, space: string) => `${'#'.repeat(Math.min(hashes.length + 2, 6))}${space}`,
  );
}

/**
 * The craftbook shelf as a picture gallery, grouped the same way the sidebar
 * and the app's New Task dialog shelve them. Rendered on `craftbooks-index`,
 * one level deep, hence the `../` hrefs.
 */
function craftbookGalleryHtml(
  books: CraftbookTemplateManifest[],
  art: Map<string, Buffer>,
): string {
  const groups = new Map<
    string,
    { title: string; order: number; books: CraftbookTemplateManifest[] }
  >();
  for (const book of books) {
    const category = resolveCraftbookCategory(book);
    const index = CRAFTBOOK_CATEGORY_META.findIndex((item) => item.id === category);
    const meta = CRAFTBOOK_CATEGORY_META[index] ?? CRAFTBOOK_CATEGORY_META.at(-1)!;
    const family = CRAFTBOOK_CATEGORY_FAMILY_META.find((f) => f.id === meta.family);
    const title =
      meta.family === 'universal' || !family ? meta.label : `${family.label} · ${meta.label}`;
    const group = groups.get(meta.id) ?? {
      title,
      order: index < 0 ? CRAFTBOOK_CATEGORY_META.length : index,
      books: [],
    };
    group.books.push(book);
    groups.set(meta.id, group);
  }
  return [...groups.values()]
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
    .map(
      (group) => `<section class="hb-gallery-group">
<h2>${escHtml(group.title)}</h2>
<ul class="hb-gallery">
${group.books
  .map((book) => {
    const href = `../craftbook/${encodeURIComponent(book.id)}/`;
    const img = art.has(book.id)
      ? `<img src="${href}${CRAFTBOOK_ART_FILE}" alt="" width="96" height="96" loading="lazy" decoding="async">`
      : '';
    return `<li><a href="${href}">${img}<span class="hb-gallery-title">${escHtml(book.name)}</span><span class="hb-gallery-summary">${escHtml(clip(firstSentence(book.description) ?? '', 110))}</span></a></li>`;
  })
  .join('\n')}
</ul>
</section>`,
    )
    .join('\n');
}

/** The craftbook's woodcut, placed under its title. */
export function craftbookArtHtml(title: string): string {
  return `<img class="hb-craftbook-art" src="${CRAFTBOOK_ART_FILE}" alt="${escHtml(title)} illustration" width="160" height="160" decoding="async">`;
}

/** Insert right after the article's h1. */
export function insertAfterTitle(body: string, html: string): string {
  const end = body.indexOf('</h1>');
  if (end === -1) return `${html}\n${body}`;
  const at = end + '</h1>'.length;
  return `${body.slice(0, at)}\n${html}${body.slice(at)}`;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function projectTypeDemo(
  catalog: SiteCatalogSource,
  pt: ProjectTypeManifest,
): Promise<SiteDemo | null> {
  const entry = safeRelativePath(pt.pages?.entry);
  if (!entry) return null;
  const prefix = `versions/${pt.version}/pages/`;
  const paths = (await catalog.listItemFiles('project-type', pt.id))
    .map((p) => p.replaceAll('\\', '/'))
    .filter((p) => p.startsWith(prefix))
    .map((p) => p.slice(prefix.length))
    .filter((p): p is string => safeRelativePath(p) !== undefined);
  if (!paths.includes(entry)) return null;
  const files: SiteDemo['files'] = [];
  for (const path of paths) {
    const bytes = await catalog.readItemFile('project-type', pt.id, `${prefix}${path}`);
    if (bytes) files.push({ path, bytes });
  }
  return { projectTypeId: pt.id, entry, files };
}

/**
 * The "Try it" section a project-type page gains when its page ships a
 * standalone demo. The frame is sandboxed without same-origin: the demo runs
 * on its own sample data and never needs the surrounding site.
 */
export function demoSectionHtml(demo: SiteDemo, title: string): string {
  const src = `demo/${demo.entry.split('/').map(encodeURIComponent).join('/')}`;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<section class="hb-demo">
<h2>Try it</h2>
<p>This is the project’s page running on sample data in your browser. It doesn’t connect to Gezel or to your files.</p>
<div class="hb-demo-frame"><iframe src="${src}" title="${esc(title)} demo" loading="lazy" sandbox="allow-forms allow-modals allow-scripts" referrerpolicy="no-referrer"></iframe></div>
<p class="hb-demo-open"><a href="${src}" target="_blank" rel="noreferrer">Open the demo in a new tab</a></p>
</section>`;
}

/** Insert after the article's opening paragraph, so the demo sits above the composition detail. */
export function insertDemoSection(body: string, section: string): string {
  const firstParagraphEnd = body.indexOf('</p>');
  if (firstParagraphEnd === -1) return `${body}\n${section}`;
  const at = firstParagraphEnd + '</p>'.length;
  return `${body.slice(0, at)}\n${section}${body.slice(at)}`;
}

function safeRelativePath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  const segments = normalized.split('/');
  if (!normalized || normalized.startsWith('/') || segments.some((s) => !s || s === '..')) {
    return undefined;
  }
  return normalized;
}

function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name);
}

function engines(m: ChatModelManifest): string[] {
  return ENGINE_LABELS.filter(([key]) => m[key] !== undefined).map(([, label]) => label);
}

function quantization(m: ChatModelManifest): string {
  const blocks = [m.llamaCpp, m.mlx, (m as { ds4?: { quantization?: string } }).ds4] as Array<
    { quantization?: string } | undefined
  >;
  return blocks.find((b) => b?.quantization)?.quantization ?? '';
}

function firstSentence(text: string | undefined): string | undefined {
  const s = text?.trim().split(/\.\s/)[0]?.replace(/\.$/, '').trim();
  return s ? `${s}.` : undefined;
}

/** Shorten at a word boundary: craftbook descriptions run long, and a card is a teaser. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:—–-]+$/, '')}…`;
}

function formatGB(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '';
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

function formatContext(tokens: number | undefined): string {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return '';
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : String(tokens);
}

function yesNo(value: boolean | undefined): string {
  return value === undefined ? '' : value ? 'Yes' : 'No';
}

/** "About 12,900" reads as an estimate; the exact count changes every week. */
function roundDown(n: number): number {
  return n >= 1000 ? Math.floor(n / 100) * 100 : n;
}

function link(text: string, url: string | undefined): string {
  return url && /^https?:\/\//.test(url) ? `[${cell(text)}](${url})` : cell(text);
}

/** A table cell cannot hold a pipe or a line break. */
function cell(text: string): string {
  return text
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

function row(cells: string[]): string {
  return `| ${cells.join(' | ')} |`;
}
