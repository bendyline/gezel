import type {
  CatalogItemDetail,
  CatalogItemSummary,
  CatalogKind,
  CraftbookTemplateManifest,
  GezelTemplateManifest,
  HandboekFigure,
  HandboekRenderMode,
  ProjectTypeManifest,
} from '@bendyline/gezel';
import type {
  ModelScore,
  ModelTier,
  RoleId,
  ScorecardDataset,
  ScorecardRun,
} from '@bendyline/gezel';
import {
  MODEL_TIER_ORDER,
  ROLES,
  SCORECARD,
  SCORECARD_DATA_ATTRS,
  buildSuiteScoreboard,
  createLogger,
  describeProvenance,
  provenanceDifferences,
  resolveRoleId,
  scoreModel,
  scorecardHardwareKey,
  scorecardHardwareLabel,
  scorecardModelFamilyId,
  toolsetGroupsForRole,
} from '@bendyline/gezel';
import { BUILTIN_TOOLSETS } from '@bendyline/gezel-catalog';
import { computeToolAllowlist, expandToolsetGroups } from '../chat/role-tool-filter.js';
import type { ReleaseNoteEntry } from './content.js';
import type { HandboekDeviceInfo, HandboekGezelInfo, HandboekModelInfo } from './device.js';
import { unwrapSoftBreaks } from './unwrap.js';

const log = createLogger('handboek');

/** The slice of CatalogService the handboek needs — stubbable in tests. */
export interface HandboekCatalog {
  list(kind: CatalogKind): Promise<CatalogItemSummary[]>;
  get(kind: CatalogKind, id: string): Promise<CatalogItemDetail | null>;
}

export interface MacroContext {
  mode: HandboekRenderMode;
  catalog: HandboekCatalog;
  device: HandboekDeviceInfo;
  /**
   * Release-note articles, newest first. Supplied by the engine from the
   * curated tree rather than read here, so the `whats-new-list` macro
   * stays a pure renderer and the tests can stub a release history.
   */
  releases: ReleaseNoteEntry[];
  /** Figures referenced by expanded markdown accumulate here. */
  figures: HandboekFigure[];
}

type MacroFn = (attrs: Record<string, string>, ctx: MacroContext) => Promise<string>;

/**
 * Autoannotation macros. Each is a leaf directive occupying its own
 * line in article markdown — `::handboek-<name>{key=value}` — and
 * expands to plain squisq-flavored markdown *before* the article is
 * parsed (squisq's `markdownToDoc` silently drops directive nodes, so
 * anything left unexpanded simply disappears from the rendered doc;
 * the no-surviving-directives test guards against typos).
 */
export const MACROS: Record<string, MacroFn> = {
  'gezel-roster': gezelRoster,
  'meester-card': meesterCard,
  'role-summary-table': roleSummaryTable,
  'role-about': roleAbout,
  'role-tools': roleTools,
  'toolset-groups': toolsetGroups,
  'craftbook-steps': craftbookSteps,
  'craftbook-list': craftbookList,
  'device-hardware': deviceHardware,
  'installed-models': installedModels,
  'model-scorecard': modelScorecard,
  'project-type-composition': projectTypeComposition,
  'suggested-work': suggestedWork,
  'whats-new-list': whatsNewList,
};

/** Releases listed inline before the rest stay reachable through the TOC. */
const WHATS_NEW_LIST_DEFAULT_LIMIT = 12;

const DIRECTIVE_RE = /^::handboek-([a-z0-9-]+)(?:\{([^}]*)\})?\s*$/;

export interface ExpandResult {
  markdown: string;
  figures: HandboekFigure[];
}

/**
 * Expand every handboek macro line in `source`. Unknown macro names are
 * left in place (they vanish harmlessly at render time, and the content
 * lint test flags them); a macro that throws logs and renders nothing so
 * one broken data source can't take down a whole article.
 */
export async function expandMacros(
  source: string,
  ctx: Omit<MacroContext, 'figures'>,
): Promise<ExpandResult> {
  const figures: HandboekFigure[] = [];
  const full: MacroContext = { ...ctx, figures };
  const lines = source.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const m = DIRECTIVE_RE.exec(line.trim());
    if (!m) {
      out.push(line);
      continue;
    }
    const [, name, rawAttrs] = m;
    const macro = MACROS[name!];
    if (!macro) {
      log.warn(`unknown handboek macro ::handboek-${name} — leaving directive in place`);
      out.push(line);
      continue;
    }
    try {
      const rendered = await macro(parseAttrs(rawAttrs ?? ''), full);
      if (rendered.trim()) out.push(rendered.trimEnd());
      // A macro that renders nothing removes its line entirely (site mode
      // omitting a personalized section shouldn't leave a blank hole).
    } catch (err) {
      log.warn(`handboek macro ::handboek-${name} failed: ${String(err)}`);
    }
  }
  return { markdown: unwrapSoftBreaks(out.join('\n')), figures };
}

/** Parse `key=value key2="quoted value"` attribute syntax. */
export function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z][\w-]*)=(?:"([^"]*)"|([^\s"]+))/g;
  for (const m of raw.matchAll(re)) {
    attrs[m[1]!] = m[2] ?? m[3] ?? '';
  }
  return attrs;
}

// ── macro implementations ─────────────────────────────────────────

const COUNT_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];

function countWord(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

function figureRef(
  ctx: MacroContext,
  gezel: { id: string; name: string; poppetje?: unknown },
  roleLabel?: string,
): string | null {
  if (!gezel.poppetje) return null;
  const path = `poppetje/${gezel.id}.headshot.svg`;
  if (!ctx.figures.some((f) => f.path === path)) {
    ctx.figures.push({
      path,
      gezelId: gezel.id,
      name: gezel.name,
      roleLabel,
      variant: 'headshot',
      // The struct is validated upstream (PoppetjeManager) — carry as-is.
      poppetje: gezel.poppetje as HandboekFigure['poppetje'],
    });
  }
  return `![${gezel.name}](${path})`;
}

function formatNames(names: string[]): string {
  const bold = names.map((n) => `**${n}**`);
  if (bold.length <= 1) return bold[0] ?? '';
  return `${bold.slice(0, -1).join(', ')} and ${bold[bold.length - 1]}`;
}

/**
 * `::handboek-gezel-roster{role=meester}` — "You have two meester
 * gezellen" and a card per gezel. Personalized: app/agent modes only;
 * the static site has no idea who your crew is.
 *
 * App mode emits one list item per gezel — figure, name, role label,
 * role summary — which the article stylesheet lays out as a card grid
 * (the shape of the item is the CSS hook: squisq's markdown carries
 * block attributes on headings only, so the macro can't class the list
 * it emits). Agent mode has no figures, so it keeps the flat sentence
 * with the names in it instead.
 */
async function gezelRoster(attrs: Record<string, string>, ctx: MacroContext): Promise<string> {
  if (ctx.mode === 'site') return '';
  const roleId = attrs.role ? resolveRoleId(attrs.role) : null;
  const all = await ctx.device.listGezels();
  const matching = roleId ? all.filter((g) => resolveRoleId(g.role) === roleId) : all;
  if (matching.length === 0) {
    if (!roleId) return '';
    const label = ROLES[roleId].label.toLowerCase();
    return `You don't have a ${label} gezel yet — the Meester can create one for you.`;
  }
  const label = roleId ? `${ROLES[roleId].label.toLowerCase()} ` : '';
  const plural = matching.length === 1 ? `${label}gezel` : `${label}gezellen`;
  const count = `You have ${countWord(matching.length)} ${plural}`;
  if (ctx.mode === 'agent') {
    return `${count}: ${formatNames(matching.map((g) => g.name))}.`;
  }
  const cards = matching.map((g) => rosterCard(ctx, g, roleId));
  return `${count}.\n\n${cards.join('\n')}`;
}

/**
 * One roster list item: figure, name, role, and what that role does.
 * Separator characters are deliberately absent — each part is its own
 * inline node so the stylesheet can stack them, and a stray dash would
 * land on a line of its own.
 *
 * A role-filtered roster drops the summary: those rosters sit inside the
 * role's own article, directly under the same sentence, so repeating it
 * once per card says nothing new.
 */
function rosterCard(
  ctx: MacroContext,
  gezel: HandboekGezelInfo,
  filterRoleId: RoleId | null,
): string {
  const id = filterRoleId ?? resolveRoleId(gezel.role);
  const role = id ? ROLES[id] : null;
  const roleLabel = role?.label ?? gezel.role?.trim();
  const parts = [figureRef(ctx, gezel, roleLabel), `**${gezel.name}**`];
  if (roleLabel) parts.push(`*${roleLabel}*`);
  if (role && !filterRoleId) parts.push(role.summary);
  return `- ${parts.filter(Boolean).join(' ')}`;
}

/** `::handboek-meester-card` — who your Meester is right now. */
async function meesterCard(_attrs: Record<string, string>, ctx: MacroContext): Promise<string> {
  const generic =
    'The Meester is your guildmaster: the first gezel you meet, and the one who helps you figure out which other gezellen you need.';
  if (ctx.mode === 'site') return generic;
  const meesterId = await ctx.device.meesterGezelId();
  if (!meesterId) return generic;
  const gezel = (await ctx.device.listGezels()).find((g) => g.id === meesterId);
  if (!gezel) return generic;
  const sentence = `Your Meester is **${gezel.name}**. ${generic}`;
  if (ctx.mode === 'agent') return sentence;
  const fig = figureRef(ctx, gezel, 'Meester');
  return fig ? `${sentence}\n\n${fig}` : sentence;
}

/** `::handboek-role-summary-table` — every built-in role at a glance. */
async function roleSummaryTable(): Promise<string> {
  const rows = Object.values(ROLES).map(
    (r) =>
      `| [${r.label}](role/${r.id}) | ${r.summary} | ${r.capabilityFloor} | ${r.defaultBooks.join(', ') || '—'} |`,
  );
  return [
    '| Role | What they do | Model floor | Default craftbooks |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/**
 * `::handboek-role-about{role=researcher}` — the role's default
 * about.md from its gilde gezel template, so role docs show the actual
 * character prose a new gezel of this role starts with.
 */
async function roleAbout(attrs: Record<string, string>, ctx: MacroContext): Promise<string> {
  const roleId = resolveRoleId(attrs.role);
  if (!roleId) return '';
  const detail = await findRoleTemplate(ctx, roleId);
  const about = detail?.about?.trim();
  if (!about) return '';
  // Demote headings one level so the template's `## Identity` sections
  // nest under the article's own structure instead of competing with it.
  return about.replace(/^(#{1,4}) /gm, '#$1 ');
}

async function findRoleTemplate(
  ctx: MacroContext,
  roleId: string,
): Promise<CatalogItemDetail | null> {
  const direct = await ctx.catalog.get('gezel-template', roleId);
  if (direct) return direct;
  const all = await ctx.catalog.list('gezel-template');
  const match = all.find((s) => {
    const manifest = s.manifest as GezelTemplateManifest;
    return resolveRoleId(manifest.role) === roleId;
  });
  return match
    ? ctx.catalog.get('gezel-template', (match.manifest as GezelTemplateManifest).id)
    : null;
}

/**
 * `::handboek-role-tools{role=researcher scope=default|device|tiers}` —
 * what a gezel of this role can do.
 *
 * - `default`: the role's built-in toolset kit as a reference table.
 * - `device`:  the kit as actually offered per model installed on THIS
 *              device (tier caps applied) — app/agent modes only; the
 *              static site falls back to the tiers view.
 * - `tiers`:   the kit per model tier, using a representative size per
 *              tier, so users see what grows as models get stronger.
 */
async function roleTools(attrs: Record<string, string>, ctx: MacroContext): Promise<string> {
  const roleId = resolveRoleId(attrs.role);
  if (!roleId) return '';
  const scope = attrs.scope ?? 'default';
  const kitGroups = toolsetGroupsForRole(roleId);
  if (scope === 'device' && ctx.mode !== 'site') {
    return deviceToolsTable(roleId, kitGroups, await ctx.device.listInstalledModels());
  }
  if (scope === 'tiers' || (scope === 'device' && ctx.mode === 'site')) {
    return tierToolsTable(roleId, kitGroups);
  }
  return defaultKitTable(kitGroups);
}

function defaultKitTable(kitGroups: readonly string[]): string {
  const byId = new Map(BUILTIN_TOOLSETS.map((g) => [g.id, g]));
  const rows: string[] = [];
  for (const groupId of kitGroups) {
    const g = byId.get(groupId);
    if (!g) continue;
    const tools = g.tools.map((t) => `\`${t}\``).join(', ');
    rows.push(`| ${g.name} | ${g.description.split('. ')[0]!.replace(/\.$/, '')} | ${tools} |`);
  }
  if (rows.length === 0) return '';
  return ['| Tool group | Purpose | Tools |', '| --- | --- | --- |', ...rows].join('\n');
}

/**
 * Summarize how much of the role's kit survives a given allowlist.
 * `null` allowlist = no filtering (the full kit).
 */
function describeKitSurface(kitGroups: readonly string[], allow: Set<string> | null): string {
  const byId = new Map(BUILTIN_TOOLSETS.map((g) => [g.id, g]));
  const kit = expandToolsetGroups(kitGroups);
  if (allow === null) return `full kit (${kit.size} tools)`;
  let kept = 0;
  const trimmed: string[] = [];
  for (const groupId of kitGroups) {
    const g = byId.get(groupId);
    if (!g) continue;
    const total = g.tools.length;
    const have = g.tools.filter((t) => allow.has(t)).length;
    kept += have;
    if (have < total)
      trimmed.push(have === 0 ? `${g.name} (off)` : `${g.name} (${have} of ${total})`);
  }
  if (trimmed.length === 0) return `full kit (${kit.size} tools)`;
  return `${kept} of ${kit.size} tools — trimmed: ${trimmed.join(', ')}`;
}

function allowlistFor(
  roleId: string,
  model: { provider: string; id: string; parameterSize?: string },
): Set<string> | null {
  return computeToolAllowlist({
    role: roleId,
    mode: 'small-model',
    provider: model.provider as never,
    modelId: model.id,
    parameterSize: model.parameterSize,
  });
}

function deviceToolsTable(
  roleId: string,
  kitGroups: readonly string[],
  models: HandboekModelInfo[],
): string {
  if (models.length === 0) {
    return 'No local models are installed on this device yet — with a cloud provider, this role gets its full kit. Install local models from the Models catalog to see the per-model surface here.';
  }
  const rows = models.map((m) => {
    const surface = describeKitSurface(kitGroups, allowlistFor(roleId, m));
    return `| ${m.name ?? m.id} | ${m.tier} | ${surface} |`;
  });
  return [
    'On this device:',
    '',
    '| Installed model | Tier | Tool surface for this role |',
    '| --- | --- | --- |',
    ...rows,
    '',
    'With a cloud provider, this role always gets its full kit.',
  ].join('\n');
}

/** Representative parameter size per local tier for the tiers view. */
const TIER_EXAMPLES: Record<
  ModelTier,
  { parameterSize?: string; provider: string; label: string }
> = {
  tiny: { parameterSize: '3B', provider: 'llama-cpp', label: 'under 5B' },
  small: { parameterSize: '8B', provider: 'llama-cpp', label: '5–12B' },
  medium: { parameterSize: '27B', provider: 'llama-cpp', label: '12–45B' },
  large: { parameterSize: '70B', provider: 'llama-cpp', label: '45B and up' },
  cloud: { provider: 'openai', label: 'hosted' },
};

function tierToolsTable(roleId: string, kitGroups: readonly string[]): string {
  const rows = MODEL_TIER_ORDER.map((tier) => {
    const ex = TIER_EXAMPLES[tier];
    const surface = describeKitSurface(
      kitGroups,
      allowlistFor(roleId, {
        provider: ex.provider,
        id: `example-${ex.parameterSize ?? 'cloud'}`,
        parameterSize: ex.parameterSize,
      }),
    );
    return `| ${tier} | ${ex.label} | ${surface} |`;
  });
  return [
    '| Tier | Model size | Tool surface for this role |',
    '| --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/** `::handboek-toolset-groups{ids=a,b}` / `{role=x}` — group reference. */
async function toolsetGroups(attrs: Record<string, string>): Promise<string> {
  let groups = BUILTIN_TOOLSETS;
  if (attrs.ids) {
    const wanted = new Set(attrs.ids.split(',').map((s) => s.trim()));
    groups = groups.filter((g) => wanted.has(g.id));
  } else if (attrs.role) {
    const wanted = new Set(toolsetGroupsForRole(attrs.role));
    groups = groups.filter((g) => wanted.has(g.id));
  }
  if (groups.length === 0) return '';
  return groups
    .map((g) => {
      const tools = g.tools.map((t) => `\`${t}\``).join(', ');
      return `### ${g.name}\n\n${g.description}\n\nTools: ${tools}`;
    })
    .join('\n\n');
}

/** `::handboek-craftbook-steps{id=research-report}` — the step walk. */
async function craftbookSteps(attrs: Record<string, string>, ctx: MacroContext): Promise<string> {
  if (!attrs.id) return '';
  const detail = await ctx.catalog.get('craftbook-template', attrs.id);
  if (!detail) return '';
  const manifest = detail.manifest as CraftbookTemplateManifest;
  const parts: string[] = [];
  const rows = manifest.steps.map((s, i) => {
    const role = s.suggestedRole
      ? (ROLES[resolveRoleId(s.suggestedRole) ?? 'developer']?.label ?? s.suggestedRole)
      : '—';
    const desc = (s.description ?? '').split('\n')[0] ?? '';
    return `| ${i + 1} | ${s.name} | ${role} | ${desc} |`;
  });
  parts.push(
    ['| # | Step | Who runs it | What happens |', '| --- | --- | --- | --- |', ...rows].join('\n'),
  );
  if (manifest.triggers?.length) {
    parts.push(
      `Say something like ${manifest.triggers.map((t) => `"${t}"`).join(' or ')} in chat to start it.`,
    );
  }
  if (manifest.toolsets?.length) {
    const names = manifest.toolsets.map((t) => `\`${t.toolsetId}\``).join(', ');
    parts.push(`Needs toolsets: ${names}.`);
  }
  return parts.join('\n\n');
}

/** `::handboek-craftbook-list{role=researcher}` — craftbook overview table. */
async function craftbookList(attrs: Record<string, string>, ctx: MacroContext): Promise<string> {
  const items = await ctx.catalog.list('craftbook-template');
  let books = items.map((s) => s.manifest as CraftbookTemplateManifest);
  const roleId = attrs.role ? resolveRoleId(attrs.role) : null;
  if (roleId) {
    const defaults = new Set(ROLES[roleId].defaultBooks);
    books = books.filter((b) => defaults.has(b.id));
  }
  if (books.length === 0) return '';
  books.sort((a, b) => a.name.localeCompare(b.name));
  const rows = books.map((b) => {
    const firstSentence = b.description.split(/\.\s/)[0]!.replace(/\.$/, '');
    return `| [${b.name}](craftbook/${b.id}) | ${firstSentence}. |`;
  });
  return ['| Craftbook | What it does |', '| --- | --- |', ...rows].join('\n');
}

/**
 * `::handboek-whats-new-list{limit=12}` — every release, newest first,
 * each with its one-line summary. Renders identically in all three modes:
 * a release history carries no install-specific facts, and it is exactly
 * what a gezel asked "what changed recently?" should be able to read.
 *
 * Targets are article ids rather than relative `.md` paths because the
 * list is generated — both the app's link handler and the site export
 * resolve ids directly, and there is no source file for the repo link
 * checker to walk.
 */
async function whatsNewList(attrs: Record<string, string>, ctx: MacroContext): Promise<string> {
  const parsed = Number.parseInt(attrs.limit ?? '', 10);
  const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : WHATS_NEW_LIST_DEFAULT_LIMIT;
  const releases = ctx.releases.slice(0, limit);
  if (releases.length === 0) return 'No releases have been written up yet.';
  return releases
    .map((r) => {
      const line = `- **[${r.title}](${r.id})**`;
      return r.summary ? `${line} — ${r.summary}` : line;
    })
    .join('\n');
}

/** `::handboek-device-hardware` — this device's local-model capacity. */
async function deviceHardware(_attrs: Record<string, string>, ctx: MacroContext): Promise<string> {
  if (ctx.mode === 'site') {
    return 'Gezel classifies each device as tiny, small, medium, or large from the memory available to local models.';
  }
  const hardware = await ctx.device.currentHardware();
  if (!hardware) return 'Hardware details are not available for this device.';
  return [
    '| Current hardware | Local-model tier |',
    '| --- | --- |',
    `| ${hardware.description} | **${hardware.tier}** |`,
  ].join('\n');
}

/** `::handboek-installed-models` — what's on this device, by tier. */
async function installedModels(_attrs: Record<string, string>, ctx: MacroContext): Promise<string> {
  if (ctx.mode === 'site') {
    return 'Gezel runs local models (llama.cpp, MLX, Ollama and friends) alongside cloud providers — the Models catalog in the app shows what fits your machine.';
  }
  const models = await ctx.device.listInstalledModels();
  if (models.length === 0) {
    return 'No local models are installed yet. Cloud providers work without any — and the Models catalog can suggest local models that fit this machine.';
  }
  const rows = models.map(
    (m) => `| ${m.name ?? m.id} | ${m.provider} | ${m.parameterSize ?? '—'} | ${m.tier} |`,
  );
  return ['| Model | Engine | Size | Tier |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

/**
 * `::handboek-model-scorecard{suite=core}` — measured results for a suite.
 * `::handboek-model-scorecard{suites=core,productivity}` — multiple suites
 * grouped beneath each run's shared provenance.
 *
 * Renders the checked-in scorecard dataset rather than any live state, so
 * the shipped article shows the same numbers on every device: these are
 * measurements from a specific machine on a specific day, not a claim
 * about the reader's hardware.
 *
 * The rendering rules are not cosmetic. Each is a guard against a true-
 * looking number the data cannot support:
 *   - the headline table holds ONE run, so every row is comparable;
 *   - results from other runs are listed separately, with the reason they
 *     are not comparable spelled out;
 *   - a sample below three trials prints as a count, never a percentage;
 *   - trials lost to infrastructure are shown, not silently dropped.
 */
async function modelScorecard(attrs: Record<string, string>, ctx: MacroContext): Promise<string> {
  const suiteIds = attrs.suites
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (suiteIds && suiteIds.length > 0) {
    // The site is the only surface with somewhere to put controls and a URL
    // to carry them, so only it gets the filterable stack. App and agent
    // readers keep the fixed markdown rounds below.
    if (ctx.mode === 'site') {
      return renderScorecardFilterHtml(SCORECARD, suiteIds, { includeTaskCount: false });
    }
    return renderScorecardRunsMarkdown(SCORECARD, suiteIds, {
      includeTaskCount: true,
      breakLabels: ctx.mode !== 'agent',
    });
  }
  const suiteId = attrs.suite?.trim();
  if (!suiteId) return '';
  return renderScorecardMarkdown(SCORECARD, suiteId, {
    includeTaskCount: ctx.mode !== 'site',
    // Agent mode hands this text to a model, where a `<br>` inside an id is
    // noise the model can quote back as part of the model name.
    breakLabels: ctx.mode !== 'agent',
  });
}

/**
 * Pure renderer behind `::handboek-model-scorecard`. Split out from the
 * macro so the rendering RULES — which are the honesty guarantees — can be
 * tested against fixture datasets instead of whatever happens to be
 * checked in.
 */
export function renderScorecardMarkdown(
  dataset: ScorecardDataset,
  suiteId: string,
  opts: { includeTaskCount: boolean; breakLabels?: boolean },
): string {
  const board = buildSuiteScoreboard(dataset, suiteId);
  if (!board || board.scores.length === 0) {
    return [
      `No ${suiteId} results have been recorded yet.`,
      '',
      'Results appear here once a scorecard sweep has been run and checked in.',
    ].join('\n');
  }

  const lines: string[] = [];

  // A model with any unmeasured task is WITHHELD rather than shown with a
  // gap. A partially-measured row invites comparison against fully-measured
  // ones, and a blank cell reads as "fine" rather than "unknown".
  const publishable = board.scores.filter((score) => score.unmeasuredScenarios.length === 0);
  const withheld = board.scores.filter((score) => score.unmeasuredScenarios.length > 0);

  lines.push(
    `**${describeProvenance(
      board.run,
      board.scores.map((s) => s.result.engine),
    )}**`,
  );
  lines.push('');
  lines.push(...scoreTable(publishable, opts.breakLabels ?? false));

  if (withheld.length > 0) {
    lines.push('');
    lines.push('Not published — some tasks could not be measured on this round:');
    lines.push('');
    for (const score of withheld) {
      lines.push(`- ${score.result.label}: ${score.unmeasuredScenarios.length} task(s) unmeasured`);
    }
  }

  // Previous rounds, most recent first. Framework and catalog changes mean
  // rounds are not strictly comparable, so each carries its own stamp and
  // sits in its own table — never merged with the current one.
  const priorRuns = dataset.runs
    .filter((run) => run.id !== board.run.id && run.suites.includes(suiteId))
    .slice(0, PRIOR_ROUNDS_SHOWN);
  for (const run of priorRuns) {
    const scores = dataset.results
      .filter((result) => result.runId === run.id && result.suiteId === suiteId)
      .map((result) => scoreModel(result, run.provenance.count))
      .filter((score) => score.unmeasuredScenarios.length === 0)
      .sort((a, b) => b.successes / b.attributableTrials - a.successes / a.attributableTrials);
    if (scores.length === 0) continue;
    const why = provenanceDifferences(board.run, run);
    lines.push('');
    lines.push(`### Earlier round — ${run.provenance.startedAt.slice(0, 10)}`);
    lines.push('');
    lines.push(
      `**${describeProvenance(
        run,
        scores.map((s) => s.result.engine),
      )}**${why.length > 0 ? ` — ${why.join(', ')}` : ''}`,
    );
    lines.push('');
    lines.push(...scoreTable(scores, opts.breakLabels ?? false));
  }

  if (opts.includeTaskCount) {
    lines.push('');
    lines.push(`Tasks in this set: ${board.scenarioIds.length}.`);
  }
  return lines.join('\n');
}

const SCORECARD_SUITE_HEADINGS: Record<string, string> = {
  core: 'General capability',
  productivity: 'Office and knowledge work',
  developer: 'Engineering work',
  'complex-work': 'Complex workflows',
};

interface ScorecardRound {
  run: ScorecardRun;
  suites: Array<{ suiteId: string; scores: ModelScore[] }>;
}

/**
 * Every round that measured at least one of `suiteIds`, newest first, with
 * each suite's models ranked inside it.
 *
 * Ranking is by successes-per-attributable-trial with the raw success count
 * as the tiebreak, matching `buildSuiteScoreboard` — a model that ran fewer
 * attributable trials must not outrank one that ran the whole set on the
 * same ratio. Shared by the markdown and the filterable HTML renderers so
 * the two surfaces can never disagree about the order they publish.
 */
function collectScorecardRounds(
  dataset: ScorecardDataset,
  suiteIds: readonly string[],
): ScorecardRound[] {
  return [...dataset.runs]
    .filter((run) => suiteIds.some((suiteId) => run.suites.includes(suiteId)))
    .sort((a, b) => b.provenance.startedAt.localeCompare(a.provenance.startedAt))
    .map((run) => ({
      run,
      suites: suiteIds
        .map((suiteId) => {
          const scores = dataset.results
            .filter((result) => result.runId === run.id && result.suiteId === suiteId)
            .map((result) => scoreModel(result, run.provenance.count))
            .sort((a, b) => {
              const ratioA = a.attributableTrials > 0 ? a.successes / a.attributableTrials : -1;
              const ratioB = b.attributableTrials > 0 ? b.successes / b.attributableTrials : -1;
              return (
                ratioB - ratioA ||
                b.successes - a.successes ||
                a.result.label.localeCompare(b.result.label)
              );
            });
          return { suiteId, scores };
        })
        .filter((suite) => suite.scores.length > 0),
    }))
    .filter((entry) => entry.suites.length > 0);
}

/**
 * Render several suites run-first rather than suite-first.
 *
 * A run's machine, engines, date, and builds apply to every suite it covered,
 * so printing that stamp once and keeping its tables together makes the real
 * comparison boundary visible. Results from different runs remain separated.
 */
export function renderScorecardRunsMarkdown(
  dataset: ScorecardDataset,
  suiteIds: readonly string[],
  opts: { includeTaskCount: boolean; breakLabels?: boolean },
): string {
  const wanted = [...new Set(suiteIds.filter(Boolean))];
  const runs = collectScorecardRounds(dataset, wanted).slice(0, PRIOR_ROUNDS_SHOWN + 1);

  if (runs.length === 0) {
    return [
      `No ${wanted.join(' or ')} results have been recorded yet.`,
      '',
      'Results appear here once a scorecard sweep has been run and checked in.',
    ].join('\n');
  }

  const lines: string[] = [];
  const headline = runs[0]!.run;
  for (const [index, entry] of runs.entries()) {
    if (index > 0) lines.push('');
    lines.push(
      `### ${index === 0 ? 'Latest round' : 'Earlier round'} — ${entry.run.provenance.startedAt.slice(0, 10)}`,
    );
    lines.push('');
    const engines = entry.suites.flatMap((suite) =>
      suite.scores.map((score) => score.result.engine),
    );
    const why = index === 0 ? [] : provenanceDifferences(headline, entry.run);
    lines.push(
      `**${describeProvenance(entry.run, engines)}**${why.length > 0 ? ` — ${why.join(', ')}` : ''}`,
    );

    for (const suite of entry.suites) {
      const publishable = suite.scores.filter((score) => score.unmeasuredScenarios.length === 0);
      const withheld = suite.scores.filter((score) => score.unmeasuredScenarios.length > 0);
      lines.push('');
      lines.push(`#### ${SCORECARD_SUITE_HEADINGS[suite.suiteId] ?? suite.suiteId}`);
      lines.push('');
      lines.push(...scoreTable(publishable, opts.breakLabels ?? false));

      if (withheld.length > 0) {
        lines.push('');
        lines.push('Not published — some tasks could not be measured on this round:');
        lines.push('');
        for (const score of withheld) {
          lines.push(
            `- ${score.result.label}: ${score.unmeasuredScenarios.length} task(s) unmeasured`,
          );
        }
      }

      if (opts.includeTaskCount) {
        lines.push('');
        lines.push(`Tasks in this set: ${entry.run.scenariosBySuite[suite.suiteId]?.length ?? 0}.`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Pure renderer behind `::handboek-model-scorecard` in **site** mode: every
 * recorded round as one HTML block, stamped so a browser script can narrow
 * the page down to the machine, model, class, or day a reader asked for.
 *
 * Three things about this shape are deliberate.
 *
 * **It is HTML, not markdown, because a round has to be a container.** The
 * filter hides and shows whole rounds and whole suite tables; markdown
 * emits a flat run of siblings with nothing to grab. The markdown pipeline
 * this passes through keeps `div`/`table` and every `data-` attribute, and
 * drops `select`/`script` — so the *content* is stamped here and the
 * *controls* are built by the script at the controls placeholder.
 *
 * **It carries every round, not the three the markdown surface shows.**
 * Elision is a reading aid when the page is a fixed stack; once a reader
 * can ask for a specific machine or date, a missing round is a control that
 * silently matches nothing.
 *
 * **It degrades to the full stack.** Without the script the reader gets
 * every round in date order — more than they asked for, never less, and
 * never a page whose controls do nothing.
 */
export function renderScorecardFilterHtml(
  dataset: ScorecardDataset,
  suiteIds: readonly string[],
  opts: { includeTaskCount: boolean },
): string {
  const wanted = [...new Set(suiteIds.filter(Boolean))];
  const rounds = collectScorecardRounds(dataset, wanted);
  if (rounds.length === 0) {
    return [
      `No ${wanted.join(' or ')} results have been recorded yet.`,
      '',
      'Results appear here once a scorecard sweep has been run and checked in.',
    ].join('\n');
  }

  const attr = SCORECARD_DATA_ATTRS;
  const headline = rounds[0]!.run;
  const labels = roundLabels(rounds.map((entry) => entry.run));
  const parts: string[] = [
    `<div class="hb-scorecard" ${attr.root}="1">`,
    `<div class="hb-scorecard-controls" ${attr.controls}="1"></div>`,
  ];

  for (const [index, entry] of rounds.entries()) {
    const { run } = entry;
    const date = run.provenance.startedAt.slice(0, 10);
    const engines = entry.suites.flatMap((suite) =>
      suite.scores.map((score) => score.result.engine),
    );
    const why = index === 0 ? [] : provenanceDifferences(headline, run);
    const models = [
      ...new Set(
        entry.suites.flatMap((suite) =>
          suite.scores.map((score) => scorecardModelFamilyId(score.result.modelId)),
        ),
      ),
    ].sort();
    const tiers = [
      ...new Set(entry.suites.flatMap((suite) => suite.scores.map((score) => score.result.tier))),
    ];

    parts.push(
      `${[
        '<div class="hb-scorecard-round"',
        `${attr.round}="${esc(run.id)}"`,
        `${attr.roundLabel}="${esc(labels.get(run.id) ?? date)}"`,
        `${attr.date}="${esc(date)}"`,
        `${attr.hardware}="${esc(scorecardHardwareKey(run.provenance.device))}"`,
        `${attr.hardwareLabel}="${esc(scorecardHardwareLabel(run.provenance.device))}"`,
        `${attr.models}="${esc(models.join(' '))}"`,
        `${attr.tiers}="${esc(tiers.join(' '))}"`,
        ...(index === 0 ? [`${attr.latest}="1"`] : []),
      ].join(' ')}>`,
      `<h4 class="hb-scorecard-round-title">${index === 0 ? 'Latest round' : 'Earlier round'} — ${esc(date)}</h4>`,
      `<p class="hb-scorecard-stamp"><strong>${esc(describeProvenance(run, engines))}</strong>${
        why.length > 0 ? ` — ${esc(why.join(', '))}` : ''
      }</p>`,
    );

    for (const suite of entry.suites) {
      const publishable = suite.scores.filter((score) => score.unmeasuredScenarios.length === 0);
      const withheld = suite.scores.filter((score) => score.unmeasuredScenarios.length > 0);
      parts.push(`<div class="hb-scorecard-suite" ${attr.suite}="${esc(suite.suiteId)}">`);
      parts.push(
        `<h5 class="hb-scorecard-suite-title">${esc(
          SCORECARD_SUITE_HEADINGS[suite.suiteId] ?? suite.suiteId,
        )}</h5>`,
      );
      parts.push(scoreTableHtml(publishable));
      if (withheld.length > 0) {
        const names = withheld
          .map(
            (score) =>
              `${score.result.label} (${score.unmeasuredScenarios.length} task(s) unmeasured)`,
          )
          .join('; ');
        parts.push(
          `<p class="hb-scorecard-withheld">Not published — some tasks could not be measured on this round: ${esc(names)}</p>`,
        );
      }
      if (opts.includeTaskCount) {
        const count = run.scenariosBySuite[suite.suiteId]?.length ?? 0;
        parts.push(`<p class="hb-scorecard-taskcount">Tasks in this set: ${count}.</p>`);
      }
      parts.push('</div>');
    }
    parts.push('</div>');
  }

  parts.push('</div>');
  // One HTML block, so no blank lines: a blank line ends the block and
  // leaves the closing tags orphaned, which the markdown parser drops.
  return parts.join('\n');
}

/**
 * A short, unique name per round for the date picker.
 *
 * Dates are not unique — 2026-08-20 carries both a Mac and a DGX Spark
 * sweep — so a bare date would offer the reader two entries they cannot
 * tell apart. Machine disambiguates those; the run id is the last resort,
 * since the schema already guarantees it is unique.
 */
function roundLabels(runs: readonly ScorecardRun[]): Map<string, string> {
  const byDate = new Map<string, ScorecardRun[]>();
  for (const run of runs) {
    const date = run.provenance.startedAt.slice(0, 10);
    byDate.set(date, [...(byDate.get(date) ?? []), run]);
  }
  const out = new Map<string, string>();
  for (const [date, sharing] of byDate) {
    for (const run of sharing) {
      if (sharing.length === 1) {
        out.set(run.id, date);
        continue;
      }
      const machine = scorecardHardwareLabel(run.provenance.device);
      const sameMachine = sharing.filter(
        (other) => scorecardHardwareLabel(other.provenance.device) === machine,
      );
      out.set(run.id, sameMachine.length === 1 ? `${date} · ${machine}` : `${date} · ${run.id}`);
    }
  }
  return out;
}

/**
 * The HTML twin of `scoreTable`. Same columns and the same omissions, plus
 * a model-family and tier stamp on every row, so the filter can hide a row
 * without knowing anything about what it says.
 */
function scoreTableHtml(scores: ModelScore[]): string {
  const attr = SCORECARD_DATA_ATTRS;
  const anyRuntime = scores.some((score) => !!score.result.runtime);
  const anyJudge = scores.some((score) => !!score.result.judge);

  const cols = ['Model', 'Size', 'Tasks passed'];
  if (anyJudge) cols.push('Quality');
  cols.push('Performance');
  if (anyRuntime) cols.push('Context', 'Memory used');

  const rows = scores.map((score) => {
    const kvCacheType = score.result.runtime?.kvCacheType;
    const cells = [
      esc(`${score.result.label}${kvCacheType ? ` (kv: ${kvCacheType})` : ''}`),
      esc(score.result.parameterSize ?? score.result.tier),
      esc(score.claim),
    ];
    if (anyJudge) {
      const judge = score.result.judge;
      cells.push(judge ? esc(`${judge.meanScore}/10 (${judge.artifacts}${NB}pieces)`) : '—');
    }
    const perf = score.result.performance;
    cells.push(
      perf
        ? `${esc(`${perf.decodeTokensPerSec}${NB}tok/s output`)}<br />${esc(
            `${perf.prefillTokensPerSec.toLocaleString()}${NB}tok/s prefill`,
          )}`
        : '—',
    );
    if (anyRuntime) {
      const runtime = score.result.runtime;
      cells.push(
        runtime ? `${Math.round(runtime.contextTokens / 1024)}K` : '—',
        runtime ? esc(`${(runtime.peakMemoryMb / 1024).toFixed(1)}${NB}GB`) : '—',
      );
    }
    const stamp = `${attr.model}="${esc(scorecardModelFamilyId(score.result.modelId))}" ${attr.tier}="${esc(score.result.tier)}"`;
    return `<tr ${stamp}>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`;
  });

  return [
    '<table>',
    `<thead><tr>${cols.map((col) => `<th>${esc(col)}</th>`).join('')}</tr></thead>`,
    `<tbody>${rows.join('')}</tbody>`,
    '</table>',
  ].join('');
}

/** Escape for HTML text and double-quoted attribute values alike. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** How many previous rounds a published table shows before history is elided. */
const PRIOR_ROUNDS_SHOWN = 2;

/**
 * A measurement and its unit are one token to a reader. Left as a plain
 * space, a narrow column splits them and `1,104 tok/s` reads as two numbers
 * stacked on top of each other.
 */
const NB = '\u00a0';

/**
 * Split a model label between its family and its size/quantization, so the
 * Model column claims the width of `35b-a3b-q4` rather than the width of
 * `qwen3.6-35b-a3b-q4`. This table is seven columns of numbers inside the
 * site's 42rem reading measure — the widest column decides how much room is
 * left for everything else.
 *
 * Labels without a size segment (`Big 27B`, `gpt-5`) are left alone: an
 * arbitrary break inside a name would be worse than a wide column.
 */
export function breakModelLabel(label: string): string {
  const match = /^(.*-)(\d+(?:\.\d+)?[bm]\b.*)$/i.exec(label);
  return match ? `${match[1]}<br>${match[2]}` : label;
}

/**
 * One results table.
 *
 * Judge and runtime columns are omitted when no model in the table carries
 * the measurement. Performance is the deliberate exception: it is a standard
 * scorecard dimension, and keeping its column visible lets an older round say
 * honestly that its throughput probe was not recorded.
 */
function scoreTable(scores: ReturnType<typeof scoreModel>[], breakLabels: boolean): string[] {
  const anyRuntime = scores.some((score) => !!score.result.runtime);
  const anyJudge = scores.some((score) => !!score.result.judge);

  const cols = ['Model', 'Size', 'Tasks passed'];
  if (anyJudge) cols.push('Quality');
  cols.push('Performance');
  if (anyRuntime) cols.push('Context', 'Memory used');

  const rows = scores.map((score) => {
    const kvCacheType = score.result.runtime?.kvCacheType;
    const modelLabel = `${score.result.label}${kvCacheType ? ` (kv: ${kvCacheType})` : ''}`;
    const cells = [
      breakLabels ? breakModelLabel(modelLabel) : modelLabel,
      score.result.parameterSize ?? score.result.tier,
      score.claim,
    ];
    if (anyJudge) {
      const judge = score.result.judge;
      // The sample count travels WITH the mean, always: it is scored only
      // over work that got produced, so a model that fails early is graded
      // on its successes alone.
      cells.push(judge ? `${judge.meanScore}/10 (${judge.artifacts}${NB}pieces)` : '—');
    }
    const perf = score.result.performance;
    cells.push(
      perf
        ? `${perf.decodeTokensPerSec}${NB}tok/s output${breakLabels ? '<br>' : ' · '}${perf.prefillTokensPerSec.toLocaleString()}${NB}tok/s prefill`
        : '—',
    );
    if (anyRuntime) {
      const runtime = score.result.runtime;
      cells.push(
        runtime ? `${Math.round(runtime.contextTokens / 1024)}K` : '—',
        runtime ? `${(runtime.peakMemoryMb / 1024).toFixed(1)}${NB}GB` : '—',
      );
    }
    return `| ${cells.join(' | ')} |`;
  });

  return [`| ${cols.join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`, ...rows];
}

/** `::handboek-project-type-composition{id=language-trainer}`. */
async function projectTypeComposition(
  attrs: Record<string, string>,
  ctx: MacroContext,
): Promise<string> {
  if (!attrs.id) return '';
  const detail = await ctx.catalog.get('project-type', attrs.id);
  if (!detail) return '';
  const manifest = detail.manifest as ProjectTypeManifest;
  const parts: string[] = [];
  if (manifest.gezels.length) {
    const rows = manifest.gezels.map(
      (g) => `| ${g.templateId} | ${g.voorman ? 'Yes — leads the project' : 'No'} |`,
    );
    parts.push(
      ['**Crew it sets up**', '', '| Gezel template | Voorman |', '| --- | --- |', ...rows].join(
        '\n',
      ),
    );
  }
  if (manifest.craftbooks.length) {
    parts.push(
      `**Craftbooks it installs:** ${manifest.craftbooks.map((c) => `\`${c}\``).join(', ')}`,
    );
  }
  if (manifest.toolsets.length) {
    parts.push(
      `**Toolsets it suggests:** ${manifest.toolsets.map((t) => `\`${t.id}\``).join(', ')}`,
    );
  }
  if (manifest.schedules.length) {
    const rows = manifest.schedules.map(
      (s) =>
        `| ${s.runMode === 'night-shift' ? 'Night Shift (once per night)' : `\`${s.cron}\``} | ${s.craftbook} |`,
    );
    parts.push(
      ['**Scheduled work**', '', '| When | Craftbook |', '| --- | --- |', ...rows].join('\n'),
    );
  }
  return parts.join('\n\n');
}

/**
 * The roles that bring their own suggested recurring work — rendered
 * live from the catalog's gezel-template `suggestedCraftbooks` so this
 * listing can never drift from content (the same anti-drift rule as the
 * runtime tool inventory, ADR 0001). Optional `template=<id>` narrows to
 * one template; default renders every template that suggests anything.
 */
async function suggestedWork(attrs: Record<string, string>, ctx: MacroContext): Promise<string> {
  const items = await ctx.catalog.list('gezel-template');
  const rows: string[] = [];
  for (const item of items) {
    const manifest = item.manifest as GezelTemplateManifest;
    if (manifest.kind !== 'gezel-template') continue;
    if (attrs.template && manifest.id !== attrs.template) continue;
    for (const suggestion of manifest.suggestedCraftbooks ?? []) {
      const cadence =
        suggestion.runMode === 'night-shift'
          ? 'Night Shift, once per night'
          : `on schedule (\`${suggestion.cron}\`)`;
      rows.push(
        `| ${manifest.name} (${manifest.role}) | \`${suggestion.craftbookId}\` | ${cadence} |`,
      );
    }
  }
  if (rows.length === 0) return '';
  return ['| Role | Suggested craftbook | When |', '| --- | --- | --- |', ...rows].join('\n');
}
