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
import type { ModelTier, RoleId, ScorecardDataset } from '@bendyline/gezel';
import {
  MODEL_TIER_ORDER,
  ROLES,
  SCORECARD,
  buildSuiteScoreboard,
  createLogger,
  describeProvenance,
  provenanceDifferences,
  resolveRoleId,
  toolsetGroupsForRole,
} from '@bendyline/gezel';
import { BUILTIN_TOOLSETS } from '@bendyline/gezel-catalog';
import { computeToolAllowlist, expandToolsetGroups } from '../chat/role-tool-filter.js';
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
};

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

/** `::handboek-device-hardware` — this device's local-model capacity. */
async function deviceHardware(_attrs: Record<string, string>, ctx: MacroContext): Promise<string> {
  if (ctx.mode === 'site') {
    return 'Gezel classifies each device as tiny, small, medium, or large from the memory available to local models. Open this page in the app to see the current device.';
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
  const suiteId = attrs.suite?.trim();
  if (!suiteId) return '';
  return renderScorecardMarkdown(SCORECARD, suiteId, { includeTaskCount: ctx.mode !== 'site' });
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
  opts: { includeTaskCount: boolean },
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
  lines.push(
    `**${describeProvenance(
      board.run,
      board.scores.map((s) => s.result.engine),
    )}**`,
  );
  lines.push('');
  lines.push('| Model | Size | Tasks passed | Not measured |');
  lines.push('| --- | --- | --- | --- |');
  for (const score of board.scores) {
    const discarded =
      score.discardedTrials > 0
        ? `${score.discardedTrials} run${score.discardedTrials === 1 ? '' : 's'} lost to the machine`
        : '—';
    lines.push(
      `| ${score.result.label} | ${score.result.parameterSize ?? score.result.tier} | ${score.claim} | ${discarded} |`,
    );
  }

  if (board.otherRunScores.length > 0) {
    lines.push('');
    lines.push('Measured in an earlier round, so not directly comparable with the table above:');
    lines.push('');
    lines.push('| Model | Tasks passed | Why it is listed apart |');
    lines.push('| --- | --- | --- |');
    for (const entry of board.otherRunScores) {
      const why = provenanceDifferences(board.run, entry.run);
      lines.push(
        `| ${entry.result.label} | ${entry.claim} | ${why.length > 0 ? why.join(', ') : 'earlier round'} |`,
      );
    }
  }

  if (opts.includeTaskCount) {
    lines.push('');
    lines.push(`Tasks in this set: ${board.scenarioIds.length}.`);
  }
  return lines.join('\n');
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
