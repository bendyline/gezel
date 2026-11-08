import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type CatalogGroundTone,
  type CraftbookTemplateManifest,
  type GezelTemplateManifest,
  type ProjectTypeCategory,
  type ProjectTypeManifest,
  catalogGroundFor,
  plainRoleTitle,
} from '@bendyline/gezel';
import type { SiteCatalog, SiteCatalogSource, SiteDemo } from './handboek-site-catalog.js';
import { writePageDemo, writePageDemoAssets } from './page-demo-export.js';
import { OPEN_IN_GEZEL_JS, openInGezelHtml } from './site-open-in-gezel.js';

/**
 * gezel.com/apps: the library of Gezel apps. Every project type in the catalog
 * gets a page — what it is, its page running on sample data with a scripted
 * companion, and what is inside (crew, craftbooks, actions, files) — and the
 * index lists them by category. Written beside the Handboek export from the
 * same site catalog, so a demo here and the one in its Handboek article are
 * the same files.
 */

/**
 * Labels as in the app's New Project rail (`new-project-meta.tsx`). The order
 * differs on purpose: a visitor meets everyday apps before technical ones.
 */
const CATEGORIES: ReadonlyArray<[ProjectTypeCategory, string]> = [
  ['home', 'Home & Family'],
  ['growth', 'Personal Growth'],
  ['game', 'Games'],
  ['events', 'Events & Journeys'],
  ['business', 'Business & Teams'],
  ['money', 'Money & Small Business'],
  ['writing', 'Writing'],
  ['creative', 'Photos & Media'],
  ['communication', 'Communication'],
  ['data', 'Data'],
  ['code', 'Code'],
  ['general', 'General'],
  ['other', 'More'],
];
const CATEGORY_LABEL = new Map(CATEGORIES);

export interface AppsSiteOptions {
  /** Directory to write; the caller owns wiping it. */
  out: string;
  /** Site-absolute path of the published Handboek, for links into it. */
  docsBase: string;
  /** Absolute origin for canonical and Open Graph URLs, e.g. `https://gezel.com`. */
  siteOrigin?: string;
  /** "Open in Gezel" on each app page; see HandboekExportOptions.openInGezel. */
  openInGezel?: boolean;
}

export interface AppsSiteResult {
  apps: number;
  demos: number;
}

interface AppCrewMember {
  templateId: string;
  role: string;
  description: string;
  lead: boolean;
}

interface AppEntry {
  manifest: ProjectTypeManifest;
  category: ProjectTypeCategory;
  ground: CatalogGroundTone | undefined;
  logo: Buffer | null;
  demo: SiteDemo | undefined;
  crew: AppCrewMember[];
  craftbooks: Array<{ id: string; name: string; description: string; art: boolean }>;
}

export async function writeAppsSite(
  catalog: SiteCatalogSource,
  site: SiteCatalog,
  opts: AppsSiteOptions,
): Promise<AppsSiteResult> {
  const list = async <T>(kind: Parameters<SiteCatalogSource['list']>[0]): Promise<T[]> =>
    (await catalog.list(kind)).map((s) => s.manifest as T);
  const templates = new Map(
    (await list<GezelTemplateManifest>('gezel-template')).map((t) => [t.id, t]),
  );
  const books = new Map(
    (await list<CraftbookTemplateManifest>('craftbook-template')).map((b) => [b.id, b]),
  );
  const demos = new Map(site.demos.map((d) => [d.projectTypeId, d]));
  const apps: AppEntry[] = [];
  for (const manifest of await list<ProjectTypeManifest>('project-type')) {
    const category = (manifest.category ?? 'other') as ProjectTypeCategory;
    const logo =
      manifest.logo === 'logo.webp'
        ? await catalog.readItemFile('project-type', manifest.id, 'logo.webp')
        : null;
    apps.push({
      manifest,
      category,
      ground: catalogGroundFor({ kind: 'project-type', category, tags: manifest.tags }),
      logo,
      demo: demos.get(manifest.id),
      crew: (manifest.gezels ?? []).flatMap((g) => {
        const t = templates.get(g.templateId);
        return t
          ? [
              {
                templateId: t.id,
                role: plainRoleTitle(t.role),
                description: t.description,
                lead: g.voorman,
              },
            ]
          : [];
      }),
      craftbooks: (manifest.craftbooks ?? []).flatMap((id) => {
        const b = books.get(id);
        return b
          ? [{ id, name: b.name, description: b.description, art: site.craftbookArt.has(id) }]
          : [];
      }),
    });
  }
  const order = new Map(CATEGORIES.map(([id], i) => [id, i]));
  apps.sort(
    (a, b) =>
      Number(!a.demo) - Number(!b.demo) ||
      (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99) ||
      a.manifest.name.localeCompare(b.manifest.name),
  );

  await mkdir(opts.out, { recursive: true });
  const css = Buffer.from(APPS_CSS);
  const cssHref = `/apps/apps.css?v=${createHash('sha256').update(css).digest('hex').slice(0, 10)}`;
  await writeFile(join(opts.out, 'apps.css'), css);
  const sharedDir = join(opts.out, '_gezel-demo');
  const shared = apps.some((a) => a.demo) ? await writePageDemoAssets(sharedDir) : [];
  const page = { ...opts, cssHref };

  await writeFile(join(opts.out, 'index.html'), indexHtml(apps, page));
  for (const app of apps) {
    const dir = join(opts.out, app.manifest.id);
    await mkdir(dir, { recursive: true });
    if (app.logo) await writeFile(join(dir, 'logo.webp'), app.logo);
    if (app.demo) {
      await writePageDemo(
        join(dir, 'demo'),
        app.demo.files,
        {
          imports: app.demo.imports,
          ...(app.demo.companion ? { companion: app.demo.companion } : {}),
        },
        { directory: sharedDir, assets: shared },
      );
    }
    await writeFile(join(dir, 'index.html'), appHtml(app, apps, page));
  }
  return { apps: apps.length, demos: apps.filter((a) => a.demo).length };
}

type PageContext = AppsSiteOptions & { cssHref: string };

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function firstSentence(text: string): string {
  const match = /^.*?[.!?](?=\s|$)/.exec(text.trim());
  return (match ? match[0] : text).trim();
}

function humanizeTool(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function demoSrc(demo: SiteDemo): string {
  return `demo/${demo.entry.split('/').map(encodeURIComponent).join('/')}`;
}

function head(title: string, description: string, path: string, ctx: PageContext): string {
  const url = ctx.siteOrigin ? `${ctx.siteOrigin}${path}` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${url ? `<link rel="canonical" href="${esc(url)}">` : ''}
<meta name="theme-color" content="#eae5d6" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#141517" media="(prefers-color-scheme: dark)">
<link rel="icon" href="/favicon.svg?v=outline" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=workbench" sizes="180x180">
${
  url
    ? `<meta property="og:type" content="website">
<meta property="og:site_name" content="Gezel">
<meta property="og:url" content="${esc(url)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(`${ctx.siteOrigin}/og-image.png?v=2`)}">
<meta name="twitter:card" content="summary_large_image">`
    : ''
}
<link rel="preload" href="/assets/fonts/hanken-grotesk-variable.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/pt-serif-700.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${esc(ctx.cssHref)}">
</head>`;
}

function masthead(): string {
  return `<header class="masthead">
<a class="logotype" href="/" aria-label="Gezel home">gezel</a>
<nav class="masthead-nav" aria-label="Site">
<a href="/apps/" aria-current="page">Apps</a>
<a href="/docs/">Docs</a>
<a href="/docs/model-scorecard/">Model scorecard</a>
<a href="/platform/">Platform</a>
<a href="https://github.com/bendyline/gezel">GitHub</a>
</nav>
</header>`;
}

function footer(ctx: PageContext): string {
  return `<footer>
<p>© 2026 Bendyline · Free and open source under the MIT license</p>
<p><a href="https://github.com/bendyline/gezel">Star on GitHub</a><span class="sep" aria-hidden="true">·</span><a href="/platform/">Platform</a><span class="sep" aria-hidden="true">·</span><a href="${esc(ctx.docsBase)}craftbooks-index/">Craftbooks</a><span class="sep" aria-hidden="true">·</span><a href="https://github.com/bendyline/gilde">Contribute an app</a></p>
</footer>`;
}

function mark(app: AppEntry, size: number, href: string): string {
  return app.logo
    ? `<img class="mark" src="${esc(href)}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async"${app.ground ? ` data-ground="${app.ground}"` : ''}>`
    : `<span class="mark mark-empty"${app.ground ? ` data-ground="${app.ground}"` : ''} aria-hidden="true">${esc(app.manifest.name.charAt(0))}</span>`;
}

function card(app: AppEntry, prefix = ''): string {
  const id = app.manifest.id;
  const lead = app.crew.find((c) => c.lead) ?? app.crew[0];
  const facts = [
    lead ? `Crew: ${lead.role}${app.crew.length > 1 ? ` + ${app.crew.length - 1}` : ''}` : '',
    app.craftbooks.length
      ? `${app.craftbooks.length} craftbook${app.craftbooks.length === 1 ? '' : 's'}`
      : '',
  ].filter(Boolean);
  return `<li class="app-card" data-category="${esc(app.category)}">
<a href="${esc(prefix + id)}/">
${mark(app, 160, `${prefix}${id}/logo.webp`)}
<span class="app-card-body">
<span class="app-card-kicker">${esc(CATEGORY_LABEL.get(app.category) ?? 'More')}</span>
<strong>${esc(app.manifest.name)}</strong>
<span class="app-card-text">${esc(firstSentence(app.manifest.description))}</span>
<span class="app-card-facts">${app.demo ? '<span class="tag tag-try">Try it here</span>' : '<span class="tag">In the app</span>'}${facts.map((f) => `<span>${esc(f)}</span>`).join('')}</span>
</span>
</a>
</li>`;
}

function indexHtml(apps: AppEntry[], ctx: PageContext): string {
  const present = CATEGORIES.filter(([id]) => apps.some((a) => a.category === id));
  const demos = apps.filter((a) => a.demo).length;
  const description = `${apps.length} Gezel apps: an interface paired with AI crew members, the plans they follow, and the actions they take. Try ${demos} of them in your browser.`;
  return `${head('Gezel apps — a page you use, and a crew that works it', description, '/apps/', ctx)}
<body>
<div class="wrap">
${masthead()}
<main>
<section class="hero">
<h1><span class="title">Gezel apps</span><span class="tagline">A page you use, and a crew that works it.</span></h1>
<p class="lede">Each app pairs an interface with AI crew members who know the job, the step-by-step plans they follow, and actions that change the app’s own files. Try ${demos} of them right here on sample data, with a scripted conversation. In Gezel they run on your computer, on your files, with the model you choose.</p>
</section>
<div class="filter">
<div class="tray" role="radiogroup" aria-label="Show apps for">
<button type="button" role="radio" class="key" aria-checked="true" data-filter="all">All</button>
${present.map(([id, label]) => `<button type="button" role="radio" class="key" aria-checked="false" tabindex="-1" data-filter="${esc(id)}">${esc(label)}</button>`).join('\n')}
</div>
<p class="filter-count" role="status" aria-live="polite">${apps.length} apps</p>
</div>
<ul class="app-grid">
${apps.map((a) => card(a)).join('\n')}
</ul>
<section class="band">
<h2>Make your own</h2>
<p>An app is plain files: an HTML page, the crew it hires, the craftbooks they follow, and small scripts for its actions. Build one for yourself, or contribute it to the catalog everyone installs from.</p>
<p class="band-links"><a href="${esc(ctx.docsBase)}building-ai-apps-inside-gezel/">Building AI apps inside Gezel</a><a href="${esc(ctx.docsBase)}gezel-page-apis/">The page APIs</a><a href="https://github.com/bendyline/gilde">The gilde catalog on GitHub</a></p>
</section>
</main>
${footer(ctx)}
</div>
<script>
(function () {
  var keys = Array.prototype.slice.call(document.querySelectorAll('.tray .key'));
  var cards = Array.prototype.slice.call(document.querySelectorAll('.app-card'));
  var status = document.querySelector('.filter-count');
  function pick(key, focus) {
    var filter = key.getAttribute('data-filter'), shown = 0;
    keys.forEach(function (k) { var on = k === key; k.setAttribute('aria-checked', String(on)); k.tabIndex = on ? 0 : -1; });
    cards.forEach(function (c) { var show = filter === 'all' || c.getAttribute('data-category') === filter; c.hidden = !show; if (show) shown++; });
    status.textContent = shown + (shown === 1 ? ' app' : ' apps');
    if (focus) key.focus();
  }
  keys.forEach(function (key, i) {
    key.addEventListener('click', function () { pick(key, false); });
    key.addEventListener('keydown', function (e) {
      var next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? keys.length - 1 : null;
      if (next === null) return;
      e.preventDefault();
      pick(keys[(next + keys.length) % keys.length], true);
    });
  });
})();
</script>
</body>
</html>
`;
}

function paramQuestions(manifest: ProjectTypeManifest): string[] {
  const props = (
    manifest.params as { properties?: Record<string, { title?: unknown }> } | undefined
  )?.properties;
  if (!props) return [];
  return Object.values(props)
    .map((p) => (typeof p.title === 'string' ? p.title.trim() : ''))
    .filter(Boolean)
    .slice(0, 3);
}

function appHtml(app: AppEntry, apps: AppEntry[], ctx: PageContext): string {
  const m = app.manifest;
  const docs = ctx.docsBase;
  const label = CATEGORY_LABEL.get(app.category) ?? 'More';
  const lead = app.crew.find((c) => c.lead) ?? app.crew[0];
  const pageTools = new Set(m.pages?.tools ?? []);
  const actions = (m.tools ?? []).filter((t) => !pageTools.has(t.name));
  const files = [...(m.workspaceSeed ?? []), ...(m.artifactsSeed ?? [])].filter(
    (f) => !/\.md$/i.test(f) || !/^(about|mission)\.md$/i.test(f),
  );
  const questions = paramQuestions(m);
  const schedules = (m.schedules ?? []).flatMap((s) => {
    const book = app.craftbooks.find((b) => b.id === s.craftbook);
    return book ? [{ name: book.name, night: s.runMode === 'night-shift' }] : [];
  });
  const more = apps
    .filter((a) => a !== app && a.demo)
    .sort((a, b) => Number(b.category === app.category) - Number(a.category === app.category))
    .slice(0, 3);

  const demo = app.demo
    ? `<section class="demo" aria-labelledby="try">
<div class="demo-head"><h2 id="try">Try it</h2><a class="text-link" href="${esc(demoSrc(app.demo))}" target="_blank" rel="noreferrer">Open in a full window<span aria-hidden="true"> ↗</span></a></div>
<p class="demo-note">${esc(m.name)} running in your browser on sample data. Use the page, or talk with ${lead ? `the ${esc(lead.role.toLowerCase())}` : 'your companion'} beside it: the conversation is scripted for this preview, and the changes stay in the page.</p>
<div class="demo-frame"><iframe src="${esc(demoSrc(app.demo))}" title="${esc(m.name)}, running on sample data" sandbox="allow-scripts allow-forms allow-modals" referrerpolicy="no-referrer"></iframe></div>
</section>`
    : `<section class="demo demo-native" aria-labelledby="try">
<h2 id="try">Runs in the Gezel app</h2>
<p>${esc(m.name)} uses Gezel’s own conversation and project views rather than a page of its own, so there is no browser preview. Install Gezel to try it.</p>
</section>`;

  const crew = app.crew.length
    ? `<section class="inside-card"><h3>The crew</h3><ul class="plain">${app.crew
        .map(
          (c) =>
            `<li><a href="${esc(docs)}role-template/${esc(c.templateId)}/"><strong>${esc(c.role)}</strong></a>${c.lead ? ' <span class="tag">Crew lead</span>' : ''}<span>${esc(firstSentence(c.description))}</span></li>`,
        )
        .join('')}</ul></section>`
    : '';
  const plans = app.craftbooks.length
    ? `<section class="inside-card"><h3>Plans it follows</h3><ul class="plain">${app.craftbooks
        .map(
          (b) =>
            `<li><a href="${esc(docs)}craftbook/${esc(b.id)}/"><strong>${esc(b.name)}</strong></a><span>${esc(firstSentence(b.description))}</span></li>`,
        )
        .join('')}</ul>${
        schedules.length
          ? `<p class="small">${schedules
              .map((s) =>
                s.night
                  ? `Runs ${esc(s.name)} overnight, once you agree.`
                  : `Runs ${esc(s.name)} on a schedule, once you agree.`,
              )
              .join(' ')}</p>`
          : ''
      }</section>`
    : '';
  const shown = actions.slice(0, 8);
  const tools = actions.length
    ? `<section class="inside-card"><h3>Actions the crew can take</h3><ul class="plain">${shown
        .map(
          (t) =>
            `<li><strong>${esc(humanizeTool(t.name))}</strong><span>${esc(firstSentence(t.description ?? ''))}</span></li>`,
        )
        .join(
          '',
        )}</ul>${actions.length > shown.length ? `<p class="small">And ${actions.length - shown.length} more.</p>` : ''}<p class="small">Each action is a small script that changes the app’s files, checked by Gezel’s security settings before it runs.</p></section>`
    : '';
  const keeps = files.length
    ? `<section class="inside-card"><h3>Files it keeps</h3><p>Plain files in the project folder you can open, back up, and read: ${files
        .map((f) => `<code>${esc(f)}</code>`)
        .join(', ')}.</p></section>`
    : '';

  return `${head(`${m.name} — a Gezel app`, m.description, `/apps/${m.id}/`, ctx)}
<body>
<div class="wrap">
${masthead()}
<main>
<nav class="crumbs" aria-label="Breadcrumb"><a href="/apps/">Apps</a><span aria-hidden="true"> / </span><span>${esc(label)}</span></nav>
<section class="app-hero">
${mark(app, 200, 'logo.webp')}
<div>
<h1>${esc(m.name)}</h1>
<p class="lede">${esc(m.description)}</p>
<p class="app-actions">${
    ctx.openInGezel
      ? `${openInGezelHtml({
          link: { kind: 'app', id: m.id },
          label: 'Open in Gezel',
          buttonClass: 'button',
          noteClass: 'open-in-gezel-note',
          downloadHref: '/#download',
        })}<a class="button button-quiet" href="/#download">Get Gezel</a>`
      : '<a class="button" href="/#download">Get Gezel</a>'
  }<a class="text-link" href="${esc(docs)}project-type/${esc(m.id)}/">Read about it in the docs<span aria-hidden="true"> →</span></a><a class="text-link" href="/platform/#ai-apps">Make one like this<span aria-hidden="true"> →</span></a></p>
</div>
</section>
${demo}
<section class="inside" aria-labelledby="inside">
<h2 id="inside">What’s inside</h2>
<div class="inside-grid">${crew}${plans}${tools}${keeps}</div>
</section>
<section class="steps" aria-labelledby="start">
<h2 id="start">Start one</h2>
<ol>
<li><a href="/#download">Download Gezel</a> for Mac, Windows or Linux. It’s free.</li>
<li>Choose <strong>New project</strong>, then <strong>${esc(label)}</strong>, then <strong>${esc(m.name)}</strong>.</li>
${questions.length ? `<li>Answer ${questions.length === 1 ? 'its question' : 'a few questions'}: ${questions.map((q) => `<em>${esc(q)}</em>`).join(' ')}</li>` : ''}
<li>${lead ? `Your ${esc(lead.role.toLowerCase())} takes it from there, on the model you choose.` : 'Your crew takes it from there, on the model you choose.'}</li>
</ol>
</section>
${
  more.length
    ? `<section class="more" aria-labelledby="more"><h2 id="more">More apps to try</h2><ul class="app-grid app-grid-small">${more
        .map((a) => card(a, '../'))
        .join('')}</ul></section>`
    : ''
}
</main>
${footer(ctx)}
</div>
${ctx.openInGezel ? `<script>\n${OPEN_IN_GEZEL_JS}</script>\n` : ''}</body>
</html>
`;
}

/** Tokens, fonts, masthead, band and footer follow gezel-site's landing page; retune them together. */
const APPS_CSS = `@font-face { font-family: 'Hanken Grotesk'; font-weight: 100 900; font-display: swap; src: url(/assets/fonts/hanken-grotesk-variable.woff2) format('woff2'); }
@font-face { font-family: 'Hanken Grotesk'; font-weight: 400; font-style: italic; font-display: swap; src: url(/assets/fonts/hanken-grotesk-400i.woff2) format('woff2'); }
@font-face { font-family: 'PT Serif'; font-weight: 400; font-display: swap; src: url(/assets/fonts/pt-serif-400.woff2) format('woff2'); }
@font-face { font-family: 'PT Serif'; font-weight: 400; font-style: italic; font-display: swap; src: url(/assets/fonts/pt-serif-400i.woff2) format('woff2'); }
@font-face { font-family: 'PT Serif'; font-weight: 700; font-display: swap; src: url(/assets/fonts/pt-serif-700.woff2) format('woff2'); }
:root {
  color-scheme: light dark;
  --bg: #eae5d6; --panel: #f3eddf; --surface: #ddd3bd; --text: #1c1c1c; --muted: #5e5e5e; --muted-strong: #4d4d4d;
  --accent: #9a5a35; --accent-hover: #80482a; --accent-soft: rgba(176, 114, 76, 0.16); --accent-line: rgba(176, 114, 76, 0.45);
  --action-bg: #9a5a35; --action-ink: #fbf7ee;
  --sage: #667f62; --border: rgba(127,127,127,0.28); --shadow: 0 1px 2px rgba(0,0,0,0.05), 0 6px 18px rgba(0,0,0,0.06);
  --serif: 'PT Serif', Georgia, serif; --sans: 'Hanken Grotesk', system-ui, -apple-system, sans-serif; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --ground-indigo: #4f5d7e; --ground-slate: #6f8aa0; --ground-teal: #5f8a86; --ground-sage: #8a9a76; --ground-forest: #4f6249; --ground-terracotta: #b0724c; --ground-rose: #c08a86; --ground-plum: #7d6378;
  --band-bg: #4f6249; --band-title: #f6f1e4; --band-text: rgba(246, 241, 228, 0.88);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141517; --panel: #1c1d20; --surface: #26282b; --text: #f0f0f0; --muted: #a8a8a8; --muted-strong: #c2c2c2;
    --accent: #d39a70; --accent-hover: #e2b08b; --accent-soft: rgba(192, 135, 93, 0.18); --accent-line: rgba(192, 135, 93, 0.45);
    --action-bg: #d39a70; --action-ink: #1a1410;
    --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 6px 18px rgba(0,0,0,0.36);
    --ground-indigo: #3e4961; --ground-slate: #576b7b; --ground-teal: #4b6b67; --ground-sage: #6b775b; --ground-forest: #3e4c39; --ground-terracotta: #88593b; --ground-rose: #946b67; --ground-plum: #614d5d;
    --band-bg: #253022; --band-title: #ece6d6; --band-text: rgba(236, 230, 214, 0.84);
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body {
  margin: 0; font-family: var(--sans); color: var(--text); background: var(--bg); line-height: 1.6; -webkit-font-smoothing: antialiased;
  background-image: repeating-linear-gradient(45deg, rgba(127,127,127,0.035) 0px, rgba(127,127,127,0.035) 1px, transparent 1px, transparent 3px);
}
a { color: var(--accent); text-decoration: none; }
a:hover { color: var(--accent-hover); }
:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent); }
code { font-family: var(--mono); font-size: 0.86em; padding: 0.08em 0.36em; border-radius: 4px; background: var(--surface); color: var(--text); }
h1, h2, h3 { font-family: var(--serif); line-height: 1.15; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 0 24px; }
header.masthead { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px 24px; padding: 28px 0 8px; }
.logotype { font-family: var(--serif); font-weight: 700; font-style: italic; font-size: 1.7rem; line-height: 1; letter-spacing: -0.01em; color: var(--text); border-radius: 4px; }
.logotype:hover { color: var(--accent); }
.masthead-nav { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 20px; }
.masthead-nav a { border-radius: 4px; font-size: 0.95rem; font-weight: 500; }
.masthead-nav a[aria-current="page"] { color: var(--text); text-decoration: underline; text-decoration-color: var(--accent-line); text-decoration-thickness: 2px; text-underline-offset: 6px; }
.hero { padding: 40px 0 28px; max-width: 760px; }
.hero h1 { margin: 0 0 1rem; }
.hero .title { display: block; font-weight: 700; font-size: clamp(2.3rem, 5.5vw, 3.4rem); line-height: 1.08; letter-spacing: -0.01em; margin: 0 0 0.3em; }
.tagline { display: block; font-family: var(--serif); font-weight: 400; font-style: italic; font-size: clamp(1.15rem, 3vw, 1.5rem); line-height: 1.35; }
.lede { margin: 0; font-size: 1.06rem; }
.text-link { font-weight: 600; }
.filter { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px 16px; margin: 12px 0 20px; }
.tray { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px; border-radius: 10px; background: color-mix(in srgb, var(--surface) 70%, transparent); border: 1px solid var(--border); box-shadow: inset 0 1px 2px rgba(0,0,0,0.08); }
.key { font: 500 0.9rem/1.2 var(--sans); color: var(--text); padding: 8px 12px; min-height: 36px; border-radius: 6px; border: 1px solid var(--border); background: linear-gradient(var(--panel), color-mix(in srgb, var(--panel) 92%, var(--surface))); box-shadow: inset 0 1px 0 rgba(255,255,255,0.25), 0 1px 1px rgba(0,0,0,0.06); cursor: pointer; }
.key:hover { background: var(--panel); border-color: var(--accent-line); }
.key[aria-checked="true"] { background: var(--action-bg); color: var(--action-ink); border-color: var(--action-bg); box-shadow: inset 0 1px 3px rgba(0,0,0,0.3); transform: translateY(1px); }
.filter-count { margin: 0; color: var(--muted); font-size: 0.9rem; }
.app-grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); gap: 16px; }
.app-card a { display: flex; flex-direction: column; height: 100%; color: inherit; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; box-shadow: var(--shadow); transition: transform 140ms ease-out, border-color 140ms ease-out; }
.app-card a:hover { transform: translateY(-2px); border-color: var(--accent-line); color: inherit; }
.app-card .mark { width: 100%; height: auto; aspect-ratio: 16 / 9; object-fit: contain; display: block; padding: 12px; }
.mark-empty { display: grid; place-items: center; font: 700 2.4rem var(--serif); color: rgba(255,255,255,0.86); }
.app-card-body { display: flex; flex-direction: column; gap: 4px; padding: 14px 16px 16px; flex: 1; }
.app-card-kicker { font-size: 0.75rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
.app-card strong { font-family: var(--serif); font-size: 1.15rem; line-height: 1.25; }
.app-card-text { color: var(--muted-strong); font-size: 0.92rem; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.app-card-facts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-top: auto; padding-top: 10px; font-size: 0.82rem; color: var(--muted); }
.tag { display: inline-block; padding: 1px 7px; border-radius: 4px; border: 1px solid var(--border); font-size: 0.78rem; font-weight: 600; color: var(--muted-strong); background: color-mix(in srgb, var(--surface) 60%, transparent); }
.tag-try { color: var(--accent); border-color: var(--accent-line); background: var(--accent-soft); }
[data-ground="indigo"] { background-color: var(--ground-indigo); } [data-ground="slate"] { background-color: var(--ground-slate); } [data-ground="teal"] { background-color: var(--ground-teal); } [data-ground="sage"] { background-color: var(--ground-sage); } [data-ground="forest"] { background-color: var(--ground-forest); } [data-ground="terracotta"] { background-color: var(--ground-terracotta); } [data-ground="rose"] { background-color: var(--ground-rose); } [data-ground="plum"] { background-color: var(--ground-plum); }
.band { margin: 64px 0 24px; padding: 36px 40px; border-radius: 10px; background: var(--band-bg); color: var(--band-text); }
.band h2 { color: var(--band-title); margin: 0 0 0.6rem; font-size: 1.7rem; }
.band p { margin: 0 0 0.8rem; max-width: 720px; }
.band-links { display: flex; flex-wrap: wrap; gap: 8px 24px; }
.band a { color: var(--band-title); font-weight: 600; text-decoration: underline; text-decoration-color: rgba(246,241,228,0.45); text-underline-offset: 4px; }
.crumbs { font-size: 0.9rem; color: var(--muted); padding: 20px 0 0; }
.app-hero { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 32px; align-items: center; padding: 20px 0 28px; }
.app-hero .mark { width: 200px; height: 200px; border-radius: 10px; object-fit: contain; padding: 14px; }
.app-hero .mark-empty { width: 200px; height: 200px; border-radius: 10px; }
.app-hero h1 { font-size: clamp(2rem, 4.5vw, 2.9rem); margin: 0 0 0.5rem; letter-spacing: -0.01em; }
.app-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 24px; margin: 1.2rem 0 0; }
.button { display: inline-flex; align-items: center; min-height: 44px; padding: 0 20px; border-radius: 6px; background: var(--action-bg); color: var(--action-ink); font-weight: 600; box-shadow: inset 0 1px 0 rgba(255,255,255,0.2), 0 1px 2px rgba(0,0,0,0.15); }
.button:hover { color: var(--action-ink); filter: brightness(1.06); }
.button-quiet { background: transparent; color: var(--text); box-shadow: inset 0 0 0 2px var(--accent-line); }
.button-quiet:hover { color: var(--accent); filter: none; box-shadow: inset 0 0 0 2px var(--accent); }
.open-in-gezel { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
.open-in-gezel[hidden], .open-in-gezel-note[hidden] { display: none; }
.open-in-gezel-note { flex-basis: 100%; font-size: 0.86rem; color: var(--muted-strong); }
.demo { margin: 8px 0 48px; }
.demo-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.demo h2, .inside h2, .steps h2, .more h2 { font-size: 1.6rem; margin: 0 0 0.4rem; }
.demo-note { margin: 0 0 14px; color: var(--muted-strong); max-width: 780px; }
.demo-frame { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: var(--panel); box-shadow: var(--shadow); }
.demo-frame iframe { display: block; width: 100%; height: min(860px, 86vh); min-height: 560px; border: 0; background: var(--bg); }
.demo-native { padding: 24px 28px; border: 1px dashed var(--border); border-radius: 10px; background: var(--panel); }
.demo-native p { margin: 0; max-width: 720px; color: var(--muted-strong); }
.inside { margin: 0 0 48px; }
.inside-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); align-items: start; gap: 16px; margin-top: 12px; }
.inside-card { padding: 18px 20px; border: 1px solid var(--border); border-radius: 10px; background: var(--panel); }
.inside-card h3 { margin: 0 0 0.6rem; font-size: 1.15rem; }
.inside-card p { margin: 0.6rem 0 0; }
.plain { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.plain li { display: grid; gap: 2px; }
.plain li > span:last-child { color: var(--muted-strong); font-size: 0.92rem; line-height: 1.45; }
.plain .tag { justify-self: start; }
.plain li:has(> .tag) { grid-template-columns: auto 1fr; column-gap: 8px; align-items: baseline; }
.plain li:has(> .tag) > span:last-child { grid-column: 1 / -1; }
.small { font-size: 0.86rem; color: var(--muted); }
.steps { margin: 0 0 48px; }
.steps ol { margin: 0.6rem 0 0; padding-left: 1.4rem; display: grid; gap: 6px; max-width: 760px; }
.steps em { font-family: var(--serif); }
.steps em + em::before { content: ' · '; font-style: normal; color: var(--muted); }
.more { margin: 0 0 32px; }
footer { padding: 28px 0 40px; margin-top: 40px; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.9rem; text-align: center; }
footer p { margin: 0.3em 0; }
footer a { color: var(--muted); }
footer a:hover { color: var(--accent); }
footer .sep { opacity: 0.45; margin: 0 9px; }
@media (max-width: 720px) {
  .app-hero { grid-template-columns: 1fr; gap: 16px; }
  .app-hero .mark, .app-hero .mark-empty { width: 120px; height: 120px; }
  .band { padding: 28px 22px; }
  .demo-frame iframe { height: 88vh; }
}
@media (prefers-reduced-motion: reduce) { .app-card a { transition: none; } .app-card a:hover { transform: none; } }
`;
