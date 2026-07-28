/**
 * Auto-injected `## Tools available this turn` block — renders the
 * post-allowlist set of MCP tools as a structured listing the model
 * can scan before deciding what to call. Solves the staleness bug
 * where about.md confidently named tools that weren't actually
 * registered (the McKinley Park weather incident: about.md said
 * `browser_navigate` but `@playwright/mcp` wasn't loaded; the model
 * emitted markup the salvage layer couldn't promote).
 * Decision record and regression map:
 * `docs/decisions/0001-runtime-tool-inventory.md`.
 *
 * Source-of-truth chain:
 *   1. The MCP bridge's `getOpenAITools()` returns post-filter
 *      `{ name, description, parameters }[]`. We rebuild from that
 *      every turn, so the listing tracks any toolset registration /
 *      removal automatically.
 *   2. Tools get bucketed into named groups via
 *      `BUILTIN_TOOL_TO_GROUP` (from `@bendyline/gezel-catalog`).
 *      Anything not in the map (third-party MCP servers the user
 *      installed) lands in a generic "Other tools" bucket at the
 *      bottom — visible but not pretending to belong to a known
 *      group.
 *   3. Group order in the rendered output mirrors `BUILTIN_TOOLSETS`
 *      array order so the model sees a stable layout across turns.
 *
 * Power-user override: when the gezel has a `tools.md` file, that
 * content fully replaces the auto-rendered block (still wrapped in
 * the same heading and trust-tier slot). The user takes
 * responsibility for keeping tools.md accurate as the install's
 * registered tools evolve.
 *
 * Tier gating: skipped for `large` and `cloud` — those models read
 * the function schema natively and the block is just token tax.
 * Local `tiny`/`small`/`medium` get it because (a) the cookbook
 * pattern lifts their tool-discipline floor and (b) they're the
 * audience that fabricates `<browser_navigate />` markup when
 * unsure.
 */

import { BUILTIN_TOOLSETS, BUILTIN_TOOL_TO_GROUP } from '@bendyline/gezel-catalog';
import { canonicalToolName } from '@bendyline/gezel-mcp';
import type { ModelTier } from './local-model-tier.js';

/** Subset of `ModelInfo` we actually render. */
export interface AvailableToolInfo {
  name: string;
  /** Rich description from MCP `server.tool('name', '<description>', ...)`. */
  description: string;
}

/**
 * Truncate a description to its first sentence OR `MAX_DESCRIPTION_CHARS`
 * — whichever comes first. The MCP server's tool descriptions are often
 * paragraph-length (when-to-call guidance, anti-fabrication anchors).
 * The first sentence is almost always the "what does it do" summary,
 * which is the right grain for a per-tool row.
 */
const MAX_DESCRIPTION_CHARS = 160;
function truncateDescription(s: string): string {
  const trimmed = s.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) return '';
  // First-sentence boundary: `.`, `!`, or `?` followed by space or
  // end-of-string. Capped at MAX_DESCRIPTION_CHARS as a safety net for
  // tool descriptions that don't punctuate their first sentence.
  const sentenceMatch = trimmed.match(/^[^.!?]*[.!?](?=\s|$)/);
  const firstSentence = sentenceMatch ? sentenceMatch[0] : trimmed;
  if (firstSentence.length <= MAX_DESCRIPTION_CHARS) return firstSentence;
  return `${firstSentence.slice(0, MAX_DESCRIPTION_CHARS - 1).trimEnd()}…`;
}

/**
 * Should the auto-rendered block fire for this session at all?
 * Local tiers benefit; large/cloud models read the function schema
 * natively and don't need the redundancy. `tools.md` overrides the
 * tier gate (power-user opt-in for any tier).
 */
function shouldRenderForTier(tier: ModelTier | undefined): boolean {
  if (tier === undefined) return true;
  return tier === 'tiny' || tier === 'small' || tier === 'medium';
}

export interface RenderToolsBlockOptions {
  /** Post-allowlist tool list from the bridge (or expected list pre-bridge). */
  tools: ReadonlyArray<AvailableToolInfo>;
  /**
   * Third-party MCP toolset ids the session has installed (e.g.
   * `@playwright/mcp`). Their individual tool names aren't known
   * pre-bridge-spawn, so we surface the toolset itself as a marker
   * — the model's function schema carries the actual tool details.
   * Renders as a separate "Plus tools from installed toolsets"
   * section at the bottom. Pass undefined / empty to omit.
   */
  thirdPartyToolsetIds?: ReadonlyArray<string>;
  /**
   * When non-empty, REPLACES the auto-rendered listing entirely. The
   * caller is expected to have read this from the per-gezel
   * `tools.md` (see `gezelToolsPath` in core). Whitespace-only
   * content is treated as absent.
   */
  customMarkdown?: string | null;
  /**
   * Capability tier — local tiers get the block; `large` and `cloud`
   * skip it. Ignored when `customMarkdown` is non-empty (the user
   * opted in regardless of tier).
   */
  modelTier?: ModelTier;
  /**
   * Provider name. When the provider has no MCP bridge (Copilot SDK,
   * Anthropic CLI, Codex CLI, Mock), the block is omitted. Only
   * matters when `customMarkdown` is empty — power users can drop a
   * tools.md for any provider and we honor it.
   */
  providerName?: string;
  /**
   * Set when an MCP bridge was expected to spawn but came up with
   * zero registered tools (gezel-mcp child failed to start, missing
   * binary, env error, listTools handshake failure, etc.). Replaces
   * the normal "Tools available this turn" listing with a hard-fail
   * notice telling the model not to fabricate tool-call markup. Without
   * this, the model believes the predicted listing, fakes calls via
   * `<function=…>` markup the salvage layer can't promote (no
   * known-tool registry to match against), and spins forever
   * narrating "let me write the files now" without ever calling
   * `write_file`. Wild-caught on Ada (Atari Combat Clone task).
   */
  bridgeFailed?: boolean;
}

/**
 * Providers whose tool schemas don't flow through the MCP bridge —
 * Copilot SDK has its own built-in tool layer; the CLI providers
 * (Claude CLI, Codex CLI) manage tool exposure inside their child
 * process. Mock has no tools at all. For these, we don't auto-render
 * a listing because the listing wouldn't reflect what the model
 * actually sees.
 */
const PROVIDERS_WITHOUT_BRIDGE = new Set([
  'copilot',
  'anthropic-cli',
  'claude-cli',
  'codex-cli',
  'mock',
]);

const WORKSPACE_SURFACE_TOOLS = new Set([
  'list_dir',
  'read_file',
  'write_file',
  'stat',
  'validate',
  'search_files',
  'find_files',
  'diff_files',
]);

const ARTIFACT_SURFACE_TOOLS = new Set([
  'list_artifacts',
  'read_artifact',
  'grep_artifact',
  'write_artifact',
  'copy_artifact_to_workspace',
]);

function renderWorkspaceArtifactGuidance(tools: ReadonlyArray<AvailableToolInfo>): string | null {
  // Membership checks run in canonical space so the guidance renders in
  // the legacy A/B arm too — but the SPELLING pushed into the prompt is
  // the advertised one, so the model is never taught a name it can't
  // see in its function schema.
  const names = new Set(tools.map((t) => t.name));
  const advertisedSpelling = (canonical: string): string | null => {
    for (const name of names) {
      if (name === canonical || canonicalToolName(name) === canonical) return name;
    }
    return null;
  };
  const hasWorkspaceSurface = tools.some((t) =>
    WORKSPACE_SURFACE_TOOLS.has(canonicalToolName(t.name)),
  );
  const hasArtifactSurface = tools.some((t) =>
    ARTIFACT_SURFACE_TOOLS.has(canonicalToolName(t.name)),
  );
  if (!hasWorkspaceSurface || !hasArtifactSurface) return null;

  const workspaceOps: string[] = [];
  const readSpelling = advertisedSpelling('read_file');
  const writeSpelling = advertisedSpelling('write_file');
  if (readSpelling) workspaceOps.push(`\`${readSpelling}\``);
  if (writeSpelling) workspaceOps.push(`\`${writeSpelling}\``);
  const workspacePhrase =
    workspaceOps.length > 0 ? workspaceOps.join(' / ') : 'the workspace file tools';
  const artifactOps: string[] = [];
  if (names.has('read_artifact')) artifactOps.push('`read_artifact`');
  if (names.has('write_artifact')) artifactOps.push('`write_artifact`');
  if (names.has('grep_artifact')) artifactOps.push('`grep_artifact`');
  const artifactPhrase = artifactOps.length > 0 ? artifactOps.join(' / ') : 'artifact tools';
  const writeArtifactWarning = names.has('write_artifact')
    ? '; `write_artifact({ path: "packages/...", content: "..." })` does not edit the workspace.'
    : '.';

  return `Workspace paths from "Workspace files" use ${workspacePhrase}. Artifacts are a separate drawer: use ${artifactPhrase} only for \`list_artifacts\` results or explicit artifact paths${writeArtifactWarning}`;
}

/**
 * Build the system-prompt block. Returns the empty string when none
 * of the gating conditions are met (caller appends unconditionally).
 */
export function renderAvailableToolsBlock(opts: RenderToolsBlockOptions): string {
  const custom = (opts.customMarkdown ?? '').trim();
  if (custom.length > 0) {
    return ['', '---', '', '## Tools available this turn', '', custom].join('\n');
  }

  if (opts.providerName && PROVIDERS_WITHOUT_BRIDGE.has(opts.providerName)) {
    return '';
  }

  // Bridge-failed override. Render BEFORE the tier gate so even
  // large/cloud models (which normally skip the tools block) get the
  // failure notice — a model with no tools needs to be told not to
  // fabricate calls regardless of its capability tier.
  if (opts.bridgeFailed) {
    return [
      '',
      '---',
      '',
      '## ⚠ MCP bridge failed — no tools wired this turn',
      '',
      'Your function-calling schema is **empty**. The MCP bridge that normally provides your tools (filesystem, code execution, tasks, memory, web, browser, etc.) failed to start for this session.',
      '',
      '**Do NOT emit `<tool_call>`, `<function=…>`, `<invoke>`, or any other tool-call markup.** The runtime cannot promote it to real calls — there is no tool registry to match against. Any markup you emit will be stripped from the visible reply and the user will see nothing.',
      '',
      'What to do this turn:',
      '',
      '1. Tell the user briefly: "My tool bridge failed to start — I can\'t actually perform any actions right now."',
      '2. Suggest they restart the service or check Settings → On-device → MCP bridge for the underlying error.',
      "3. End your turn. Do not retry; the bridge state won't change within this turn.",
    ].join('\n');
  }

  if (!shouldRenderForTier(opts.modelTier)) return '';

  const thirdPartyIds = opts.thirdPartyToolsetIds ?? [];
  if (opts.tools.length === 0 && thirdPartyIds.length === 0) return '';

  // Tier-keyed verbosity:
  //   tiny  — full per-tool descriptions, one bullet per tool. The
  //           cookbook audience: <5B models that benefit from the
  //           pedagogical "what does X do" alongside each name.
  //   small/medium — names only, comma-packed per group. The function
  //           schema already carries descriptions; bigger models read
  //           them natively. We keep the grouped layout so the model
  //           still sees a "this is what's wired" map and won't
  //           fabricate calls to unregistered tools.
  // Saves ~700 tokens for a typical 60-tool surface on small/medium.
  const verbose = opts.modelTier === 'tiny' || opts.modelTier === undefined;

  const grouped = groupTools(opts.tools);
  const lines: string[] = [];
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Tools available this turn');
  lines.push('');
  lines.push(
    verbose
      ? "These are the tools wired into your session right now. Every entry is real and callable; check your function schema for the full description and arguments. Don't fabricate a call to a tool that isn't on this list — the runtime detects it and the user sees a warning."
      : "Tools wired this turn (descriptions + args in your function schema). Don't fabricate calls to tools not on this list.",
  );
  lines.push('');

  for (const { groupName, tools } of grouped) {
    lines.push(`### ${groupName}`);
    if (verbose) {
      for (const t of tools) {
        const desc = truncateDescription(t.description);
        lines.push(desc ? `- \`${t.name}\` — ${desc}` : `- \`${t.name}\``);
      }
    } else {
      lines.push(tools.map((t) => `\`${t.name}\``).join(', '));
    }
    lines.push('');
  }

  const workspaceArtifactGuidance = renderWorkspaceArtifactGuidance(opts.tools);
  if (workspaceArtifactGuidance) {
    lines.push('### Workspace vs Artifacts');
    lines.push(workspaceArtifactGuidance);
    lines.push('');
  }

  if (thirdPartyIds.length > 0) {
    lines.push('### From installed toolsets');
    lines.push(
      verbose
        ? 'These toolsets are bridged into this session and contribute additional tools to your function schema (their per-tool descriptions live there):'
        : 'Bridged toolsets (tools live in your function schema):',
    );
    for (const id of thirdPartyIds) {
      lines.push(`- \`${id}\``);
    }
    lines.push('');
  }
  // Trailing blank from the last group iteration is fine — keeps the
  // following section visually separated. join trims via the prompt
  // builder's surrounding context.
  return lines.join('\n').replace(/\n+$/, '');
}

interface GroupedTools {
  groupName: string;
  tools: AvailableToolInfo[];
}

/**
 * Heuristic group-id for an unmapped tool name — anything not owned by
 * `@bendyline/gezel-mcp` (i.e. not in `BUILTIN_TOOL_TO_GROUP`). Today
 * this catches the `@playwright/mcp` browser surface, whose ~21
 * `browser_*` tools would otherwise dump into a generic "Other tools"
 * bucket alongside `web_search` / `fetch_url` under "Web Access".
 * Splitting Playwright's browser-control surface from the genuinely
 * unrelated lookup tools confused small models into thinking they had
 * two separate web stories — the listing's job is to be a clear
 * "where do I look for X" map, and `browser_navigate` belongs with
 * `fetch_url`, not with whatever other third-party MCP a user
 * installed.
 *
 * Returns the BUILTIN_TOOLSETS group id to bucket into, or undefined to
 * fall through to "Other tools". Add new heuristics here as
 * third-party MCP servers grow conventions worth grouping.
 */
function inferGroupForUnmappedTool(toolName: string): string | undefined {
  if (toolName.startsWith('browser_')) return 'web';
  return undefined;
}

/**
 * Partition the tool list into groups. Built-in groups appear in the
 * order they're declared in `BUILTIN_TOOLSETS`; anything unmapped
 * lands in a single "Other tools" bucket at the end. Within a group,
 * tools keep their input order (which matches `getOpenAITools()`'s
 * own ordering — typically registration order, stable across turns).
 */
function groupTools(tools: ReadonlyArray<AvailableToolInfo>): GroupedTools[] {
  const buckets = new Map<string, AvailableToolInfo[]>();
  const others: AvailableToolInfo[] = [];
  for (const t of tools) {
    const group =
      BUILTIN_TOOL_TO_GROUP.get(t.name) ?? BUILTIN_TOOL_TO_GROUP.get(canonicalToolName(t.name));
    const groupId = group?.id ?? inferGroupForUnmappedTool(t.name);
    if (!groupId) {
      others.push(t);
      continue;
    }
    let arr = buckets.get(groupId);
    if (!arr) {
      arr = [];
      buckets.set(groupId, arr);
    }
    arr.push(t);
  }
  const out: GroupedTools[] = [];
  for (const g of BUILTIN_TOOLSETS) {
    const tools = buckets.get(g.id);
    if (tools && tools.length > 0) out.push({ groupName: g.name, tools });
  }
  if (others.length > 0) out.push({ groupName: 'Other tools', tools: others });
  return out;
}
