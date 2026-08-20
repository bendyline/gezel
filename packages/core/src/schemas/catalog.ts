import { z } from 'zod';
import { ProjectIconIdSchema } from '../project-icons.js';
import { TaskAssigneeSchema } from './assignee.js';
import {
  CraftbookBasedOnSchema,
  CraftbookConnectorNeedSchema,
  CraftbookRequirementSchema,
  CraftbookRunModesSchema,
  CraftbookScriptsSchema,
  CraftbookSpawnSchema,
  CraftbookStepSchema,
  CraftbookToolsetNeedSchema,
} from './craftbook.js';
import { ProviderNameSchema } from './gezel.js';
import { HookSpecSchema } from './hook.js';
import { BehaviorEntrySchema, ModelStyleSchema } from './model-profile.js';
import { ChatModelTuningSchema } from './model-tuning.js';
import { PreviewSourceSchema } from './preview.js';
import { ProjectTabVisibilitySchema } from './project.js';

/**
 * ─ Catalog items ────────────────────────────────────────────────────
 *
 * Everything the app recommends, installs, or offers to install lives in a
 * catalog. Each item is a folder with a `manifest.json` (identity layer)
 * and a `versions/` subfolder whose children are semver-named folders
 * holding the technical payload for that version.
 *
 * ```
 * data/{kind}/{shard}/{id}/
 * ├── manifest.json           ← identity (this file)
 * ├── logo.svg                ← (optional) shared across versions
 * └── versions/
 *     ├── 1.0.0/
 *     │   ├── manifest.json   ← per-version technical details
 *     │   └── about.md        ← (templates only) the prompt prose
 *     └── 1.3.0/
 *         └── ...
 * ```
 *
 * The "resolved" manifest schemas below are the wire shape the
 * `CatalogService` returns: identity + a chosen version flattened into
 * one object plus an `availableVersions: string[]` list. UI + HTTP
 * consumers always work with the resolved shape.
 *
 * Built-in toolsets (`builtin.*`) are synthetic — they don't live on
 * disk and they ship versioned with the app binary.
 */

// Allow dots and colons to support real-world Ollama tag names like
// `llama3.2` or `qwen2.5:7b`. Length cap keeps filesystem paths sane.
const IdRegex = /^[a-z0-9][a-z0-9.\-:]{1,63}$/;

// Loose semver: major.minor.patch with optional pre-release / build tags.
// Strict enough to reject `latest` or `v1` while still accepting common
// pre-release shapes (`1.0.0-rc.1`, `1.0.0+build.7`).
const SemverRegex = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// ─ License presentation ─────────────────────────────────────────────
//
// `license` holds the full upstream name; these fields add the UI-facing
// classification used by the model managers' license button.

/**
 * Coarse license bucket driving the license button's label + tone. Picked
 * once per model and kept consistent with `commercialUse`:
 *   - `open`                  → permissive (Apache/MIT/BSD/OpenMDW 1.0–1.1);
 *                               commercial use and redistribution are OK.
 *                               Always paired with `commercialUse: true`.
 *   - `commercial-restricted` → non-commercial license; free for personal
 *                               and research use. Paired with
 *                               `commercialUse: false`.
 *   - `custom-restricted`     → commercial use allowed but under custom or
 *                               use-based terms (RAIL, "community", and
 *                               revenue-threshold licenses). Paired with
 *                               `commercialUse: true`.
 */
export const LicenseClassSchema = z.enum(['open', 'commercial-restricted', 'custom-restricted']);
export type LicenseClass = z.infer<typeof LicenseClassSchema>;

/**
 * License presentation fields shared by every model manifest. Spread into
 * the identity schema (validates the root `manifest.json`) and the
 * assembled image/video manifest schemas (the shape served to the UI).
 *   - `licenseShortName` — a terse name for the button, e.g. "Apache 2.0",
 *     "OpenRAIL++-M", "Krea 2 Community". Falls back to `license` when absent.
 *   - `licenseUrl` — direct link to the license text/page. A HuggingFace
 *     blob URL where the upstream repo ships a license file, otherwise the
 *     model card. Falls back to `upstream` when absent.
 */
export const LicenseMetaShape = {
  licenseClass: LicenseClassSchema.optional(),
  licenseShortName: z.string().optional(),
  licenseUrl: z.string().url().optional(),
} as const;

/**
 * Recommendation weight. Optional, hand-curated: a model that carries a
 * `recoScore` (and a fully-open `licenseClass: 'open'` license) is a
 * "recommended" model — it earns the ★ Recommended badge on the model
 * screen, and the first-run picker ranks recommended models by this score
 * (higher = preferred) when choosing what to install. Absent → not
 * recommended. Deliberately spread wherever {@link LicenseMetaShape} is, so
 * every model kind (chat / image / video / audio) inherits it.
 *
 * A score alone is never enough: every surface routes through
 * `isRecommendedModel` (`packages/core/src/recommendation.ts`), which also
 * requires `licenseClass === 'open'` and — for chat models, which declare it —
 * `supportsTools !== false`. So a stray score on a restricted or tool-less
 * model is ignored rather than trusted.
 */
export const RecoMetaShape = {
  recoScore: z.number().int().positive().optional(),
} as const;

// ─ Identity layer ────────────────────────────────────────────────────
//
// Stable across versions. Changing identity ("the github toolset is now
// called gh") is a "different thing" signal, not a version bump.

/**
 * Oldest gezel build that can meaningfully use this content. Authored as
 * `1.YYDDD` (the date-based app version's major.minor — see
 * scripts/stamp-version.mjs); an optional third component is compared too.
 * Comparison is numeric per component with missing components as 0
 * (`satisfiesMinGezelVersion` in packages/core/src/gezel-version.ts).
 *
 * On an identity manifest it gates the whole item; on a version manifest it
 * gates that version only, so older builds fall back to older eligible
 * versions. The resolved manifest carries the effective floor — the stricter
 * of identity and chosen version. Unstamped dev builds (`0.0.0`) never
 * filter. Authoring rule: add floors on new item versions, never retro-add
 * them to existing ones — older versions are the compatibility path for
 * older gezel builds.
 */
export const MinGezelVersionShape = {
  minGezelVersion: z.string().optional(),
} as const;

const IdentityCommonSchema = z.object({
  ...MinGezelVersionShape,
  schemaVersion: z.literal(1),
  id: z.string().regex(IdRegex),
  name: z.string().min(1),
  description: z.string(),
  tags: z.array(z.string()).default([]),
  maintainer: z.object({
    name: z.string(),
    url: z.string().url().optional(),
  }),
  /** Filename (relative to the manifest) or an absolute URL. */
  logo: z.string().optional(),
  license: z.string().optional(),
  ...LicenseMetaShape,
  ...RecoMetaShape,
  /**
   * Versions to skip when picking "latest" — kept on disk so callers
   * can still pin them explicitly (modeled on npm's `deprecated`).
   */
  yankedVersions: z.array(z.string()).default([]),
  /**
   * Versions strictly below this string are filtered from listings
   * entirely. Use to drop ancient versions from the UI without nuking
   * on-disk history.
   */
  minSupportedVersion: z.string().optional(),
});

// ─ Toolsets ─────────────────────────────────────────────────────────

/**
 * Coarse functional bucket for the catalog browser's category facet.
 * Auto-derived from name/description keywords during catalog import
 * (see `packages/catalog/src/categorize.ts`); a manual `category`
 * value in an identity manifest takes precedence over the heuristic.
 *
 * Kept deliberately small so the UI can render a compact list of tabs
 * — `other` is the catch-all for anything the heuristic can't place.
 */
export const ToolsetCategorySchema = z.enum([
  'search',
  'dev-tools',
  'data',
  'cloud',
  'productivity',
  'communication',
  'content',
  'ai',
  'media',
  'other',
]);
export type ToolsetCategory = z.infer<typeof ToolsetCategorySchema>;

/**
 * Category bucket for the New Project gallery's rail. Same contract as
 * {@link ToolsetCategorySchema}: a small enum the UI fully controls, with
 * `other` as the catch-all. Declared on the identity manifest (taxonomy is
 * stable across versions); the UI hides categories with no types in them,
 * so shipping a type with a new category lights its rail entry up.
 */
export const ProjectTypeCategorySchema = z.enum([
  'general',
  'code',
  'communication',
  'creative',
  'writing',
  'growth',
  'game',
  'data',
  'home',
  'money',
  'events',
  'other',
]);
export type ProjectTypeCategory = z.infer<typeof ProjectTypeCategorySchema>;

export const ToolsetPlatformSchema = z.enum([
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
]);
export type ToolsetPlatform = z.infer<typeof ToolsetPlatformSchema>;

/**
 * SHA256-pinned npm package. The install pipeline `npm pack`s the declared
 * version, hashes the tarball, and refuses if it doesn't match. No
 * "trust on first use."
 */
const NpmPackageRuntimeSchema = z.object({
  kind: z.literal('npm-package'),
  package: z
    .string()
    .min(1)
    .max(214)
    .regex(/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/),
  version: z
    .string()
    .min(1)
    .max(128)
    .regex(
      /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    ),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** Entry inside the extracted package (relative to package root). */
  entry: z
    .string()
    .min(1)
    .max(512)
    .refine(
      (entry) =>
        !entry.includes('\\') &&
        !entry.includes('\0') &&
        !entry.startsWith('/') &&
        entry.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
      'entry must be a contained POSIX-style relative path',
    ),
  /** Extra args passed after the entry. */
  args: z
    .array(
      z
        .string()
        .max(4096)
        .refine((arg) => !arg.includes('\0')),
    )
    .max(64)
    .default([]),
  envHints: z
    .array(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/))
    .max(64)
    .default([]),
});

/**
 * A remote, hosted MCP server (URL). Simplest to "install" because there's
 * nothing to download — we just register the URL with the provider.
 *
 * `transport` distinguishes the two HTTP variants the MCP spec defines:
 * `streamable-http` is the current single-endpoint shape (the default
 * for new servers); `sse` is the older two-endpoint variant kept for
 * back-compat with registry entries that still declare it.
 */
const HttpMcpRuntimeSchema = z.object({
  kind: z.literal('http-mcp'),
  url: z.string().url(),
  transport: z.enum(['streamable-http', 'sse']).default('streamable-http'),
  authHint: z.enum(['none', 'bearer', 'oauth']).default('none'),
  envHints: z.array(z.string()).default([]),
});

/**
 * Downloaded platform-specific binary with per-arch sha256. Kept in the
 * schema for forward compatibility; install pipeline support is a
 * follow-up.
 */
const BinaryMcpRuntimeSchema = z.object({
  kind: z.literal('stdio-mcp-binary'),
  binaries: z.record(
    ToolsetPlatformSchema,
    z.object({ url: z.string().url(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  ),
  args: z.array(z.string()).default([]),
  envHints: z.array(z.string()).default([]),
});

/**
 * A built-in tool group exposed by the in-process MCP server. No
 * subprocess to spawn — installing one of these into a toolsets just
 * unlocks the named subset of tools that the main MCP server already
 * registers. `toolsetGroupId` references an entry in
 * `BUILTIN_TOOLSETS` (packages/catalog/src/builtin-toolsets.ts).
 */
const BuiltinRuntimeSchema = z.object({
  kind: z.literal('builtin'),
  toolsetGroupId: z.string(),
});

/**
 * A user-supplied MCP server. Unlike catalog toolsets, these entries do not
 * download a pinned package: they either point back at a project-owned MCP
 * config file or carry the normalized command/URL from an explicit import.
 *
 * Environment variables and HTTP headers from explicit imports are stored in
 * SecretStore. Only their field names are persisted here. Project-file
 * entries are re-read from the approved project config at session-build time,
 * so editing `.gezel/mcp.json`, `.vscode/mcp.json`, or `.mcp.json` takes effect
 * without copying credentials into Gezel's ordinary JSON state.
 */
const CustomMcpRuntimeSchema = z
  .object({
    kind: z.literal('custom-mcp'),
    serverName: z.string().min(1).max(256),
    transport: z.enum(['stdio', 'streamable-http', 'sse']),
    source: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('project-file'),
        relativePath: z.enum(['.gezel/mcp.json', '.vscode/mcp.json', '.mcp.json']),
      }),
      z.object({
        kind: z.literal('imported'),
        sourceName: z.string().min(1).max(512).optional(),
      }),
    ]),
    command: z.string().min(1).max(4096).optional(),
    args: z.array(z.string().max(16_384)).max(256).default([]),
    cwd: z.string().max(4096).optional(),
    envFile: z.string().max(4096).optional(),
    url: z.string().max(16_384).optional(),
    envKeys: z.array(z.string().min(1).max(256)).max(256).default([]),
    headerKeys: z.array(z.string().min(1).max(256)).max(256).default([]),
  })
  .superRefine((runtime, ctx) => {
    // Project-file records are lightweight references. Their live command or
    // URL is deliberately not persisted and is recovered from the file.
    if (runtime.source.kind === 'project-file') return;
    if (runtime.transport === 'stdio' && !runtime.command) {
      ctx.addIssue({
        code: 'custom',
        path: ['command'],
        message: 'imported stdio MCP servers require a command',
      });
    }
    if (runtime.transport !== 'stdio' && !runtime.url) {
      ctx.addIssue({
        code: 'custom',
        path: ['url'],
        message: 'imported HTTP MCP servers require a URL',
      });
    }
  });

export const ToolsetRuntimeSchema = z.discriminatedUnion('kind', [
  NpmPackageRuntimeSchema,
  HttpMcpRuntimeSchema,
  BinaryMcpRuntimeSchema,
  BuiltinRuntimeSchema,
  CustomMcpRuntimeSchema,
]);
export type ToolsetRuntime = z.infer<typeof ToolsetRuntimeSchema>;

/**
 * One typed configuration field declared by a toolset manifest. The user
 * fills these in at install time (or edits later); the values become the
 * env the MCP subprocess sees. `secret` is orthogonal to `type` — any
 * type can be a secret (string tokens, URLs that embed keys, etc.) and
 * secret-flagged values are routed to the SecretStore instead of the
 * plaintext config file.
 */
export const ToolsetConfigFieldSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  type: z.enum(['string', 'enum', 'url', 'number', 'boolean']),
  secret: z.boolean().default(false),
  required: z.boolean().default(false),
  default: z.string().optional(),
  options: z.array(z.string()).optional(),
  multiline: z.boolean().default(false),
  pattern: z.string().optional(),
  placeholder: z.string().optional(),
  /** Env var name when spawning the MCP subprocess. Defaults to `id`. */
  envVar: z.string().optional(),
});
export type ToolsetConfigField = z.infer<typeof ToolsetConfigFieldSchema>;

/** Identity layer for a toolset entry. Lives in the root `manifest.json`. */
export const ToolsetIdentitySchema = IdentityCommonSchema.extend({
  kind: z.literal('toolset'),
  /**
   * Coarse functional bucket. Optional in the manifest because the
   * 3,800+ community manifests aren't hand-tagged — the catalog index
   * builder fills in a derived value via keyword heuristics. Setting
   * this explicitly in a manifest pins a manual override.
   */
  category: ToolsetCategorySchema.optional(),
});
export type ToolsetIdentity = z.infer<typeof ToolsetIdentitySchema>;

/**
 * Per-version toolset payload. Lives in
 * `versions/{version}/manifest.json`.
 */
export const ToolsetVersionManifestSchema = z.object({
  ...MinGezelVersionShape,
  schemaVersion: z.literal(1),
  /** Must equal the parent folder name. Validated at load time. */
  version: z.string().regex(SemverRegex),
  /** ISO timestamp when this version was authored. */
  releasedAt: z.string(),
  runtime: ToolsetRuntimeSchema,
  /**
   * Declared tools the toolset exposes. Optional — purely for display in
   * the catalog browser. The live list comes from the MCP server itself
   * at spawn time.
   */
  tools: z.array(z.object({ name: z.string(), description: z.string().default('') })).default([]),
  /** Typed configuration fields the user must (or may) supply. */
  config: z.array(ToolsetConfigFieldSchema).default([]),
  requirements: z
    .object({
      node: z.string().optional(),
      platforms: z.array(ToolsetPlatformSchema).optional(),
    })
    .optional(),
  /** Short release notes; full prose lives in a sibling `notes.md`. */
  notes: z.string().optional(),
});
export type ToolsetVersionManifest = z.infer<typeof ToolsetVersionManifestSchema>;

/**
 * Resolved view returned from the catalog: identity + a chosen version
 * flattened into a single object, plus an `availableVersions` list.
 * UI + HTTP consumers work with this shape.
 */
export const ToolsetManifestSchema = z.object({
  ...MinGezelVersionShape,
  schemaVersion: z.literal(1),
  kind: z.literal('toolset'),
  id: z.string().regex(IdRegex),
  name: z.string().min(1),
  description: z.string(),
  tags: z.array(z.string()).default([]),
  maintainer: z.object({
    name: z.string(),
    url: z.string().url().optional(),
  }),
  logo: z.string().optional(),
  license: z.string().optional(),
  version: z.string(),
  releasedAt: z.string(),
  runtime: ToolsetRuntimeSchema,
  tools: z.array(z.object({ name: z.string(), description: z.string().default('') })).default([]),
  config: z.array(ToolsetConfigFieldSchema).default([]),
  requirements: z
    .object({
      node: z.string().optional(),
      platforms: z.array(ToolsetPlatformSchema).optional(),
    })
    .optional(),
  notes: z.string().optional(),
  availableVersions: z.array(z.string()).default([]),
  category: ToolsetCategorySchema.optional(),
});
export type ToolsetManifest = z.infer<typeof ToolsetManifestSchema>;

// ─ Gezel templates ──────────────────────────────────────────────────

export const GezelTemplateIdentitySchema = IdentityCommonSchema.extend({
  kind: z.literal('gezel-template'),
  role: z.string(),
  /** When true, the template is offered in the "New Meester" flow. */
  meesterCandidate: z.boolean().default(false),
});
export type GezelTemplateIdentity = z.infer<typeof GezelTemplateIdentitySchema>;

/**
 * A recurring craftbook run a gezel template recommends for any project
 * its gezel joins ("suggested night work"). Never auto-armed: the
 * suggested-work layer surfaces these as toggles and only a user action
 * (UI toggle or an MCP enable on the user's behalf) materializes the
 * host task. `night-shift` items run inside the configured Night Shift
 * window at most once per window; `scheduled` items are plain cron
 * (UTC) spawn hosts and therefore require `cron`.
 */
export const SuggestedCraftbookSchema = z
  .object({
    craftbookId: z.string(),
    runMode: z.enum(['night-shift', 'scheduled']),
    /** 5-field cron (UTC). Required for 'scheduled'; ignored for 'night-shift'. */
    cron: z.string().optional(),
    /** Overlap policy for the materialized host. */
    overlap: z.enum(['skip', 'queue', 'concurrent']).optional(),
    /** Default craftbook params seeding the enable form / spawned children. */
    params: z.record(z.string(), z.string()).optional(),
    /** One-liner shown next to the toggle ("keeps an eye on new code overnight"). */
    reason: z.string().optional(),
  })
  .refine((v) => v.runMode !== 'scheduled' || !!v.cron, {
    message: 'scheduled suggestions require cron',
  });
export type SuggestedCraftbook = z.infer<typeof SuggestedCraftbookSchema>;

export const GezelTemplateVersionManifestSchema = z.object({
  ...MinGezelVersionShape,
  schemaVersion: z.literal(1),
  version: z.string().regex(SemverRegex),
  releasedAt: z.string(),
  /**
   * Filename of the `about.md` content relative to *this version's*
   * folder. The install flow reads it and passes it to `createGezel`.
   * Conventionally `about.md`.
   */
  about: z.string(),
  suggestedProvider: ProviderNameSchema.optional(),
  suggestedModel: z.string().optional(),
  /** Toolset ids (see ToolsetManifest.id) to pre-install for the new gezel. */
  suggestedTools: z.array(z.string()).default([]),
  notes: z.string().optional(),
  /**
   * Extra frontmatter to merge onto the new gezel at install time.
   * Today only `fixedFunction` flows through here — when present, the
   * gezel skips the LLM and forwards messages to the named MCP tool.
   * The catalog ingestion path forwards this verbatim to
   * `Store.createGezel`, where it's serialized into `gezel.md` and the
   * about.md write is suppressed.
   *
   * Schema-loose (`z.record`) on the catalog side so a future template
   * can add a new frontmatter shape without rev'ing the catalog
   * package; the strong typing happens server-side at gezel parse
   * time via `GezelFrontmatterSchema`.
   */
  frontmatter: z.record(z.string(), z.unknown()).optional(),
  /**
   * Suggested instance names shown as quick-pick chips in the install
   * dialog. The user can pick one or type their own. Used today for
   * fixed-function templates that should never bake a creative name
   * into the template id (the `image-generator` template might
   * suggest "Picasso", "Vermeer", … but the template stays
   * capability-shaped). Optional — templates without suggestions fall
   * back to the shared random-name pool.
   */
  nameSuggestions: z.array(z.string()).optional(),
  /**
   * Recurring craftbook runs this role recommends for projects its gezel
   * joins — surfaced by the suggested-work layer as opt-in toggles.
   */
  suggestedCraftbooks: z.array(SuggestedCraftbookSchema).optional(),
});
export type GezelTemplateVersionManifest = z.infer<typeof GezelTemplateVersionManifestSchema>;

export const GezelTemplateManifestSchema = z.object({
  ...MinGezelVersionShape,
  schemaVersion: z.literal(1),
  kind: z.literal('gezel-template'),
  id: z.string().regex(IdRegex),
  name: z.string().min(1),
  description: z.string(),
  tags: z.array(z.string()).default([]),
  maintainer: z.object({
    name: z.string(),
    url: z.string().url().optional(),
  }),
  logo: z.string().optional(),
  license: z.string().optional(),
  version: z.string(),
  releasedAt: z.string(),
  role: z.string(),
  about: z.string(),
  suggestedProvider: ProviderNameSchema.optional(),
  suggestedModel: z.string().optional(),
  suggestedTools: z.array(z.string()).default([]),
  meesterCandidate: z.boolean().default(false),
  notes: z.string().optional(),
  availableVersions: z.array(z.string()).default([]),
  /**
   * Extra frontmatter the install path should merge onto the new gezel
   * — today only carries `fixedFunction`. Mirrored verbatim from the
   * version manifest so consumers (catalog list endpoint, install UI)
   * can detect fixed-function templates without re-fetching the
   * version manifest.
   */
  frontmatter: z.record(z.string(), z.unknown()).optional(),
  /** Suggested instance names for the install dialog's quick-pick chips. */
  nameSuggestions: z.array(z.string()).optional(),
  /** Mirrored from the version manifest — see GezelTemplateVersionManifestSchema. */
  suggestedCraftbooks: z.array(SuggestedCraftbookSchema).optional(),
});
export type GezelTemplateManifest = z.infer<typeof GezelTemplateManifestSchema>;

// ─ Craftbook templates ──────────────────────────────────────────────
//
// Catalog-distributed workflow recipes. Each template ships steps with
// edges, optional onEnter/onExit script refs, and (in versioned form)
// per-step prompt prose. The TaskManager copies a template's resolved
// content into a task's embedded craftbook at create time — running
// tasks are insulated from edits to the source template.

/**
 * The lifecycle role a craftbook plays in a project. This is deliberately
 * separate from project-type tags: recipes for unrelated project types may
 * still share the same assumption about whether the workspace is blank or
 * already established.
 */
export const CraftbookRoleSchema = z.enum(['project-starter', 'maintenance-review', 'general']);
export type CraftbookRole = z.infer<typeof CraftbookRoleSchema>;

/** Shared shelf copy so every craftbook browser presents roles consistently. */
export const CRAFTBOOK_ROLE_META: ReadonlyArray<{
  id: CraftbookRole;
  label: string;
  description: string;
}> = [
  {
    id: 'project-starter',
    label: 'New project starters',
    description: 'greenfield recipes that establish a new project in a blank workspace',
  },
  {
    id: 'maintenance-review',
    label: 'Maintenance & review',
    description: 'inspect, repair, improve, and keep existing work healthy',
  },
  {
    id: 'general',
    label: 'General work',
    description: 'research, content, operations, and other reusable recipes',
  },
];

export const CraftbookTemplateIdentitySchema = IdentityCommonSchema.extend({
  kind: z.literal('craftbook-template'),
  /** Coarse project-lifecycle shelf used by craftbook browsers. */
  role: CraftbookRoleSchema.default('general'),
  /**
   * Optional workflow tag for filtering / Gilde browser facets
   * (e.g. "review-loop", "publish-pipeline"). Free-form.
   */
  workflow: z.string().optional(),
});
export type CraftbookTemplateIdentity = z.infer<typeof CraftbookTemplateIdentitySchema>;

export const CraftbookTemplateVersionManifestSchema = z.object({
  ...MinGezelVersionShape,
  schemaVersion: z.literal(1),
  version: z.string().regex(SemverRegex),
  releasedAt: z.string(),
  /**
   * Filename of the about.md prose, relative to this version's folder.
   * Conventionally `about.md`. Empty string means no prose.
   */
  about: z.string(),
  /**
   * The craftbook's structural shape: steps with ids, names, edges,
   * optional script refs. Step prompts may be inlined here (`prompt`
   * field on a step) or supplied via separate `steps/{stepId}/prompt.md`
   * files inside the version folder; the loader inlines the file form
   * at resolution time when the manifest field is absent.
   */
  steps: z.array(CraftbookStepSchema).min(1),
  entryStepId: z.string().min(1),
  defaultAssignee: TaskAssigneeSchema.optional(),
  /** Credit + link to the upstream work this version adapts. */
  basedOn: CraftbookBasedOnSchema.optional(),
  plan: z.string().optional(),
  notes: z.string().optional(),
  /** Declarative per-item fanout config (see {@link CraftbookSpawnSchema}). */
  spawn: CraftbookSpawnSchema.optional(),
  /** User-speech phrases that route to this craftbook from chat. */
  triggers: z.array(z.string()).optional(),
  /** Pre/PostToolUse hooks installed while this craftbook is active. */
  hooks: z.array(HookSpecSchema).optional(),
  /**
   * Bundled gezel scripts copied into `~/.gezel/projects/{id}/scripts/`
   * on first invocation. Each entry is a filename inside the version's
   * `scripts/` subfolder; the loader reads + installs them. Provenance
   * is recorded as `craftbook:<id>@<version>` so re-installs upgrade
   * and uninstalls clean up.
   */
  bundledScripts: z.array(z.string()).optional(),
  /**
   * Squisq/JSON-Schema object whose top-level `properties` are the
   * params the command launcher collects (rendered as a squisq form and
   * as positional CLI tokens). See `CraftbookSchema.paramSchema`.
   */
  paramSchema: z.record(z.string(), z.unknown()).optional(),
  /** CLI token the launcher stages; defaults to the craftbook id. */
  command: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .optional(),
  /** Prerequisites for the craftbook to be offered (see CraftbookSchema). */
  requirements: z.array(CraftbookRequirementSchema).optional(),
  /** Unattended launch modes this recipe is suitable for. */
  runModes: CraftbookRunModesSchema.optional(),
  /**
   * Toolset (MCP/CLI/API) dependencies this craftbook declares. Drives the
   * launcher's install/config affordance and per-toolset auto-allow. See
   * {@link CraftbookToolsetNeedSchema}.
   */
  toolsets: z.array(CraftbookToolsetNeedSchema).optional(),
  /**
   * Connector dependencies this craftbook declares. The launcher binds +
   * syncs them so the first step reads a local corpus instead of calling a
   * live API. See {@link CraftbookConnectorNeedSchema}.
   */
  connectors: z.array(CraftbookConnectorNeedSchema).optional(),
});
export type CraftbookTemplateVersionManifest = z.infer<
  typeof CraftbookTemplateVersionManifestSchema
>;

export const CraftbookTemplateManifestSchema = z.object({
  ...MinGezelVersionShape,
  schemaVersion: z.literal(1),
  kind: z.literal('craftbook-template'),
  id: z.string().regex(IdRegex),
  name: z.string().min(1),
  description: z.string(),
  tags: z.array(z.string()).default([]),
  maintainer: z.object({
    name: z.string(),
    url: z.string().url().optional(),
  }),
  logo: z.string().optional(),
  license: z.string().optional(),
  version: z.string(),
  releasedAt: z.string(),
  role: CraftbookRoleSchema.default('general'),
  workflow: z.string().optional(),
  about: z.string(),
  steps: z.array(CraftbookStepSchema).min(1),
  entryStepId: z.string().min(1),
  defaultAssignee: TaskAssigneeSchema.optional(),
  /** Credit + link to the upstream work this resolved template adapts. */
  basedOn: CraftbookBasedOnSchema.optional(),
  plan: z.string().optional(),
  notes: z.string().optional(),
  /** Declarative per-item fanout config (mirrored from the version manifest). */
  spawn: CraftbookSpawnSchema.optional(),
  availableVersions: z.array(z.string()).default([]),
  /** User-speech triggers (mirrored from the version manifest). */
  triggers: z.array(z.string()).optional(),
  /** Hooks installed while active (mirrored from the version manifest). */
  hooks: z.array(HookSpecSchema).optional(),
  /**
   * Inline script sources (name → TypeScript), from the single-document
   * `craftbook.json` version payload. When present, `bundledScripts` is
   * derived (`Object.keys(scripts).map((n) => n + '.ts')`) so legacy
   * consumers keep working for one release.
   */
  scripts: CraftbookScriptsSchema.optional(),
  /** Bundled script filenames installed on first invocation. */
  bundledScripts: z.array(z.string()).optional(),
  /** Launcher param schema (mirrored from the version manifest). */
  paramSchema: z.record(z.string(), z.unknown()).optional(),
  /** CLI token the launcher stages (mirrored from the version manifest). */
  command: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .optional(),
  /** Applicability prerequisites (mirrored from the version manifest). */
  requirements: z.array(CraftbookRequirementSchema).optional(),
  /** Unattended launch modes (mirrored from the version manifest). */
  runModes: CraftbookRunModesSchema.optional(),
  /** Toolset dependencies (mirrored from the version manifest). */
  toolsets: z.array(CraftbookToolsetNeedSchema).optional(),
  /** Connector dependencies (mirrored from the version manifest). */
  connectors: z.array(CraftbookConnectorNeedSchema).optional(),
});
export type CraftbookTemplateManifest = z.infer<typeof CraftbookTemplateManifestSchema>;

// ─ Project types ─────────────────────────────────────────────────────
//
// A project type outfits a whole project for a kind of work: a gezel role
// template, craftbooks, sandboxed scripts + script-backed tools, suggested
// toolsets, an Output page (dashboard), seed data, and scheduled work — all
// composed into one installable, shareable catalog item. "Learn Spanish" is
// a project *instance* of the Language Trainer project type.
//
// This is a composition manifest, not a plugin. Every field references or
// embeds an already-existing primitive; the instantiation engine
// (`applyProjectType`) materializes them into a concrete project at adoption
// time. See docs/project-types.md.

/** A gezel the project type sets up. References a gilde template by id. */
export const ProjectTypeGezelSchema = z.object({
  /** Gezel-template id (see {@link GezelTemplateManifestSchema}). */
  templateId: z.string(),
  /** When true, this gezel is set as the project's voorman on adoption. */
  voorman: z.boolean().default(false),
});
export type ProjectTypeGezelRef = z.infer<typeof ProjectTypeGezelSchema>;

/**
 * A toolset the project type wants installed. Always a catalog reference
 * (id + optional pinned source) — a project type never embeds toolset
 * code. `need: 'required'` installs on adoption (consent-gated);
 * `'suggested'` is offered. `autoAllow` pre-authorizes the named tools
 * while a related craftbook is active, mirroring
 * {@link CraftbookToolsetNeedSchema}.
 */
export const ProjectTypeToolsetSchema = z.object({
  id: z.string(),
  sourceId: z.string().optional(),
  need: z.enum(['required', 'suggested']).default('suggested'),
  autoAllow: z.array(z.string()).default([]),
  reason: z.string().optional(),
});
export type ProjectTypeToolsetRef = z.infer<typeof ProjectTypeToolsetSchema>;

/**
 * A gezel turn summoned when a PAGE-invoked tool completes successfully.
 * Fires ONLY through the first-party page-invoke route (a model-called
 * tool never reacts — no self-loops by construction; the route is
 * root/ui-gated, so a session token cannot fire it either). Declaring a
 * reaction on a tool not listed in `pages.tools` is inert.
 */
export const ProjectTypeToolReactionSchema = z.object({
  /**
   * templateId of the roster gezel who should take the turn. Falls back
   * to the project's voorman when no roster member matches.
   */
  gezel: z.string(),
  /**
   * Seed template delivered as a system-authored message into the target
   * gezel's live project session. Substitutions: `{{tool}}`, flattened
   * `{{output.<field>}}` dot-paths from the script run's output, and the
   * project's type params. Write it to act on the LATEST state it embeds —
   * rapid page events coalesce into one turn.
   */
  prompt: z.string().min(1),
  /**
   * When true, the rendered seed is delivered to the gezel (the model
   * needs the embedded state — the board, the last move) but hidden from
   * the chat transcript UI: no bubble renders for it. Use for pure
   * facilitation prompts that would only be noise to the human reader
   * (the checkers "[Checkers page]: Your opponent played …" seed). The
   * gezel's own reply — its move and table talk — still shows. Defaults
   * to false, so existing project types are unchanged.
   */
  hideSeed: z.boolean().optional(),
});
export type ProjectTypeToolReaction = z.infer<typeof ProjectTypeToolReactionSchema>;

/**
 * A script-backed tool the project type exposes on its sessions' tool
 * surface. The handler runs a declared SDK script (a key in the manifest's
 * `scripts` map) through the sandboxed `ScriptRunner` — capability-declared,
 * reviewable TypeScript, no npm install. This is the safe substitute for
 * "ship your own MCP server."
 */
export const ProjectTypeToolSchema = z.object({
  /** Tool name the model calls. Lowercase snake to match MCP tool naming. */
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  description: z.string(),
  /** Script name (key in the manifest `scripts` map) that handles the call. */
  script: z.string(),
  /** JSON-schema for the tool's input, validated before dispatch. */
  inputs: z.record(z.string(), z.unknown()).optional(),
  /**
   * Static args merged OVER the model's input at dispatch. Lets several
   * tools share one multiplexing script (`record_session` and
   * `advance_level` both call `progress-store`, differing only in
   * `action`) — the tool's identity IS the binding.
   */
  bind: z.record(z.string(), z.unknown()).optional(),
  /** Gezel turn summoned when this tool completes via a page invoke. */
  reaction: ProjectTypeToolReactionSchema.optional(),
});
export type ProjectTypeTool = z.infer<typeof ProjectTypeToolSchema>;

/**
 * A scheduled craftbook run the project type sets up. Created disabled or
 * consent-prompted per `consent` — never silently armed. The schedule
 * materializes as a cron task spawning the named craftbook (see
 * `TaskCronSchema`).
 */
export const ProjectTypeScheduleSchema = z
  .object({
    /**
     * How the run recurs. `scheduled` (the default, preserving every
     * manifest authored before this field existed) fires on `cron`;
     * `night-shift` runs inside the configured Night Shift window at
     * most once per window and needs no cron.
     */
    runMode: z.enum(['scheduled', 'night-shift']).default('scheduled'),
    /** Standard 5-field cron expression (UTC). Required for 'scheduled'. */
    cron: z.string().optional(),
    /** Craftbook id (from this manifest's `craftbooks`) to run each fire. */
    craftbook: z.string(),
    /** Whether the schedule is armed on adoption. Default asks the user. */
    consent: z.enum(['ask', 'auto', 'disabled']).default('ask'),
    /** Overlap policy when a prior run is still going. */
    overlap: z.enum(['skip', 'queue', 'concurrent']).optional(),
  })
  .refine((v) => v.runMode !== 'scheduled' || !!v.cron, {
    message: 'scheduled project-type schedules require cron',
  });
export type ProjectTypeSchedule = z.infer<typeof ProjectTypeScheduleSchema>;

/** Output page tree pinned into the project's Output pane (served read-only). */
export const ProjectTypePreviewReadSchema = z.object({
  /** Additional source tree a type page may read through its capability. */
  source: PreviewSourceSchema,
  /** Exact project-relative file, or subtree root when `subtree` is true. */
  path: z.string().min(1),
  subtree: z.boolean().optional(),
});
export type ProjectTypePreviewRead = z.infer<typeof ProjectTypePreviewReadSchema>;

export const ProjectTypePagesSchema = z.object({
  /** Entry HTML relative to the version's `pages/` folder, e.g. `dashboard/index.html`. */
  entry: z.string(),
  /**
   * Output Pane API generation this page is authored against. Serving does
   * not branch on it (the v1 shim is always injected for type pages); it
   * routes gilde lint (v0 vs v1 page checks) and documents intent. Omitted
   * on legacy pages that hand-roll the v0 postMessage sentinels.
   */
  api: z.literal(1).optional(),
  /** Trusted, declarative cross-directory/source reads needed by this page. */
  reads: z.array(ProjectTypePreviewReadSchema).optional(),
  /**
   * Names from `tools[]` a served page may invoke through the first-party
   * parent bridge (the page-invoke route). Page-ONLY surface: listed names
   * are excluded from the session's model tool registration — otherwise a
   * checkers gezel could call `user_move` and play the user's pieces. A
   * tool needed on both surfaces declares two names sharing one
   * script + bind.
   */
  tools: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).optional(),
});
export type ProjectTypePages = z.infer<typeof ProjectTypePagesSchema>;

/**
 * Fields shared by the per-version payload and the resolved manifest. Every
 * one is optional so a minimal project type (just a gezel + about) validates.
 */
const ProjectTypeCompositionShape = {
  /**
   * Optional taxonomy base (a `PROJECT_TYPES` id). The instantiation engine
   * inherits its detection profile and `craftbookTags` — a custom type
   * layers on top of a builtin category rather than redefining detection.
   */
  extends: z.string().optional(),
  /**
   * Whether projects instantiated from this type receive ambient Meester
   * progress check-ins. When explicitly declared, `applyProjectType` maps
   * this to the project's `nudgeConfig.enabled` setting. Omit it to preserve
   * the project's existing setting (and therefore its global-default
   * inheritance).
   */
  meesterManaged: z.boolean().optional(),
  /**
   * Optional project-tab defaults applied at adoption. Missing keys preserve
   * the project's existing setting or the UI's historical default. Chat and
   * Settings are intentionally not configurable.
   */
  tabVisibility: ProjectTabVisibilitySchema.optional(),
  /**
   * Project shape for instances of this type. `solo` marks a single-gezel
   * "Builder" experience (games, the chat room): the one roster gezel
   * does everything, no separate overseer voorman is recruited, and the UI
   * collapses the crew picker to that lead. Maps onto the project's `mode`
   * at adoption. Omit for the default crew shape.
   */
  mode: z.enum(['crew', 'solo']).optional(),
  /**
   * Custom label for this type's project lead, shown wherever the generic
   * "Voorman" / "Builder" would appear (the chat chip, project
   * settings) — e.g. checkers uses "Opponent". Aimed at solo types that
   * want a domain word instead of "Builder". The underlying data field
   * stays `voormanGezelId`; only the rendered label changes.
   */
  leadLabel: z.string().min(1).optional(),
  /**
   * Lean-agent profile. When true, this type's gezels are focused
   * single-purpose workers (a game opponent, a chat-room persona), NOT
   * general developer agents: they get a minimal tool surface (only the
   * type's own script tools plus `ask_user_question` — the whole
   * workspace / code-intel / tasks / delegation builtin surface is
   * stripped) and a lean prompt (the developer-agent scaffolding — the
   * tool cookbook, "Web work", file-editing rules — is omitted). This is
   * what keeps a small local model from drowning in 60+ irrelevant tools
   * and ~7k tokens of coding guidance while trying to play checkers.
   * Omit for the default full-agent profile.
   */
  leanProfile: z.boolean().optional(),
  /**
   * Whether projects instantiated from this type should participate in
   * workspace indexing. `false` is appropriate for lightweight stateful
   * experiences (board games, language practice, chat rooms) whose seeded
   * workspace files do not benefit from structural/code intelligence.
   * Omit to preserve the project's existing setting (enabled by default).
   */
  indexingEnabled: z.boolean().optional(),
  /**
   * Squisq/JSON-Schema object whose top-level `properties` are the params
   * collected at adoption (rendered as a form) and substituted into the
   * about/mission templates and seed files. Same shape as
   * {@link CraftbookTemplateVersionManifestSchema}'s `paramSchema`.
   */
  params: z.record(z.string(), z.unknown()).optional(),
  /**
   * Inline template for the suggested project instance name shown during
   * adoption, e.g. `{{language}} Language Trainer`. The picker keeps this
   * suggestion in sync with params until the user edits the name.
   */
  nameTemplate: z.string().min(1).optional(),
  /** Filename (in the version folder) of the param-templated project about.md. */
  aboutTemplate: z.string().optional(),
  /** Filename (in the version folder) of the param-templated mission.md. */
  missionTemplate: z.string().optional(),
  /** Gezels to create from gilde templates on adoption. */
  gezels: z.array(ProjectTypeGezelSchema).default([]),
  /** Toolsets to install (by catalog reference) on adoption. */
  toolsets: z.array(ProjectTypeToolsetSchema).default([]),
  /** Craftbook ids to install project-local on adoption. */
  craftbooks: z.array(z.string()).default([]),
  /** Inline SDK script sources (name → TypeScript), installed with provenance markers. */
  scripts: CraftbookScriptsSchema.optional(),
  /** Script-backed tools exposed on this project's sessions. */
  tools: z.array(ProjectTypeToolSchema).default([]),
  /** Output page pinned into the project's Output pane. */
  pages: ProjectTypePagesSchema.optional(),
  /** Scheduled craftbook runs (consent-gated). */
  schedules: z.array(ProjectTypeScheduleSchema).default([]),
  /** Filenames (in the version folder) of initial workspace data files, param-templated. */
  workspaceSeed: z.array(z.string()).default([]),
  /**
   * Filenames (in the version folder) of initial project-artifact files,
   * param-templated. For types whose output lives in `artifacts/` (a design
   * gallery, a report set) rather than the workspace. Same seeding as
   * {@link ProjectTypeCompositionShape.workspaceSeed}, different destination.
   */
  artifactsSeed: z.array(z.string()).default([]),
  notes: z.string().optional(),
} as const;

/** Identity layer for a project type. Lives in the root `manifest.json`. */
export const ProjectTypeIdentitySchema = IdentityCommonSchema.extend({
  kind: z.literal('project-type'),
  category: ProjectTypeCategorySchema.optional(),
  /** Small monochrome maker's mark inherited by project instances. */
  icon: ProjectIconIdSchema.optional(),
});
export type ProjectTypeIdentity = z.infer<typeof ProjectTypeIdentitySchema>;

/** Per-version project-type payload. Lives in `versions/{version}/manifest.json`. */
export const ProjectTypeVersionManifestSchema = z.object({
  ...MinGezelVersionShape,
  schemaVersion: z.literal(1),
  version: z.string().regex(SemverRegex),
  releasedAt: z.string(),
  ...ProjectTypeCompositionShape,
});
export type ProjectTypeVersionManifest = z.infer<typeof ProjectTypeVersionManifestSchema>;

/** Resolved view returned from the catalog: identity + chosen version, flattened. */
export const ProjectTypeManifestSchema = z.object({
  ...MinGezelVersionShape,
  schemaVersion: z.literal(1),
  kind: z.literal('project-type'),
  id: z.string().regex(IdRegex),
  name: z.string().min(1),
  description: z.string(),
  tags: z.array(z.string()).default([]),
  category: ProjectTypeCategorySchema.optional(),
  /** Small monochrome maker's mark inherited by project instances. */
  icon: ProjectIconIdSchema.optional(),
  maintainer: z.object({
    name: z.string(),
    url: z.string().url().optional(),
  }),
  logo: z.string().optional(),
  license: z.string().optional(),
  version: z.string(),
  releasedAt: z.string(),
  ...ProjectTypeCompositionShape,
  availableVersions: z.array(z.string()).default([]),
});
export type ProjectTypeManifest = z.infer<typeof ProjectTypeManifestSchema>;

// ─ Connector types (external-data sources) ──────────────────────────
//
// A connector binds a project to an external source (mail, calendar, an
// MCP server, a Prismatic component) and mirrors it into a normalized,
// AI-readable corpus. The manifest is mostly configuration over a generic
// `driver`; `native` adapters (mail, calendar) map to service code.

const ConnectorDriverSchema = z.enum(['mcp', 'script', 'spectral', 'native']);

const ConnectorNormalizeSchema = z.union([
  z.object({ kind: z.literal('mapping'), map: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal('script'), script: z.string() }),
  z.object({ kind: z.literal('native') }),
]);

const ConnectorActionSchema = z.object({
  name: z.string(),
  /** Consent gate this action clears at commit time (e.g. `recipient-allowlist`). */
  consentScope: z.string(),
});

/**
 * Short, human-facing guidance shown before a connector's configuration
 * fields. Catalog content owns this because the steps and destination belong
 * to the external service, while the UI only owns their presentation.
 */
const ConnectorSetupInstructionsSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  steps: z.array(z.string().min(1)).optional(),
  url: z.string().url().optional(),
  urlLabel: z.string().min(1).optional(),
});

const ConnectorTypeCompositionShape = {
  /** Which driver executes the fetch. */
  driver: ConnectorDriverSchema,
  /** JSON-schema for the per-binding config form. */
  configSchema: z.record(z.string(), z.unknown()).optional(),
  /** Shape of the credential the binding stores in the SecretStore. */
  secretShape: z.record(z.string(), z.unknown()).optional(),
  /** Concise setup guidance rendered above the binding form. */
  setupInstructions: ConnectorSetupInstructionsSchema.optional(),
  /**
   * Driver-specific fetch config: `{adapterId}` (native) | `{server,list,fetch}`
   * (mcp) | `{fetch|cli}` (script) | `{component,action,...}` (spectral).
   */
  source: z.record(z.string(), z.unknown()),
  /** How a fetched record becomes a canonical record. */
  normalize: ConnectorNormalizeSchema.default({ kind: 'native' }),
  /** Declared write-back actions (Phase 7; outbox-invoked, never model-exposed). */
  actions: z.array(ConnectorActionSchema).default([]),
  /** Whether the corpus is a faithful mirror or a rolling window. */
  completeness: z.enum(['mirror', 'window']).optional(),
  /**
   * HTTPS origins this connector's per-binding credential may be sent to
   * by a `script`-driver fetch (`gezel.http.authed` enforces a
   * destination-origin allowlist). Entries are literal origins
   * (`https://api.github.com`) or `$config.<path>` placeholders resolved
   * from the binding's config at bind time. Written into the project's
   * `credentialAllowedOrigins` for the binding's own credential name only;
   * native drivers ignore it (their network never crosses the sandbox
   * boundary).
   */
  allowedOrigins: z.array(z.string()).optional(),
  notes: z.string().optional(),
} as const;

/** Identity layer for a connector type. Lives in the root `manifest.json`. */
export const ConnectorTypeIdentitySchema = IdentityCommonSchema.extend({
  kind: z.literal('connector-type'),
});
export type ConnectorTypeIdentity = z.infer<typeof ConnectorTypeIdentitySchema>;

/** Per-version connector-type payload. Lives in `versions/{version}/manifest.json`. */
export const ConnectorTypeVersionManifestSchema = z.object({
  ...MinGezelVersionShape,
  schemaVersion: z.literal(1),
  version: z.string().regex(SemverRegex),
  releasedAt: z.string(),
  ...ConnectorTypeCompositionShape,
});
export type ConnectorTypeVersionManifest = z.infer<typeof ConnectorTypeVersionManifestSchema>;

/** Resolved view returned from the catalog: identity + chosen version, flattened. */
export const ConnectorTypeManifestSchema = z.object({
  ...MinGezelVersionShape,
  schemaVersion: z.literal(1),
  kind: z.literal('connector-type'),
  id: z.string().regex(IdRegex),
  name: z.string().min(1),
  description: z.string(),
  tags: z.array(z.string()).default([]),
  maintainer: z.object({
    name: z.string(),
    url: z.string().url().optional(),
  }),
  logo: z.string().optional(),
  license: z.string().optional(),
  version: z.string(),
  releasedAt: z.string(),
  ...ConnectorTypeCompositionShape,
  availableVersions: z.array(z.string()).default([]),
});
export type ConnectorTypeManifest = z.infer<typeof ConnectorTypeManifestSchema>;

// ─ Chat models (shared across Ollama + llama.cpp + MLX providers) ────
//
// A single catalog entry describes a model and carries per-provider
// source info on the version manifest (`ollama.tag`,
// `llamaCpp.huggingfaceRepo` + `filename`, `mlx.huggingfaceRepo`).
// Either source block is optional — some models only ship via one
// backend — but at least one must be present per version. Most chat
// models live their whole life with a single `versions/1.0.0/` folder;
// new versions appear when an Ollama tag changes its underlying
// weights, when a quant is rehosted, or when MLX support is added.

export const ChatModelCategorySchema = z.enum([
  'general',
  'coding',
  'reasoning',
  'vision',
  'embedding',
]);
export type ChatModelCategory = z.infer<typeof ChatModelCategorySchema>;

/** Per-entry Ollama source: just a pull tag. Lifecycle/integrity owned by Ollama. */
export const ChatModelOllamaSourceSchema = z.object({
  /** The pull tag — exactly what `ollama pull <tag>` expects. */
  tag: z.string(),
});
export type ChatModelOllamaSource = z.infer<typeof ChatModelOllamaSourceSchema>;

/**
 * Per-entry llama.cpp source: a Hugging Face repo plus either a single
 * GGUF (`filename` + `sha256`) or a sharded set (`shards[]`). Sharded
 * sources are used for models too large to fit HF's 50 GB LFS file cap,
 * which forces uploaders like `bartowski` and `ggml-org` to split big
 * quants into `*-00001-of-NNNNN.gguf` files. llama.cpp auto-discovers
 * the rest when launched with the first shard via `--model`.
 *
 * Invariant: exactly one of (filename + sha256) or (shards) must be set.
 */
const ShardEntrySchema = z.object({
  /** Filename within the HF repo, e.g. `model-Q4_K_M-00001-of-00002.gguf`. May include a subdirectory. */
  name: z.string(),
  /** SHA-256 of this shard, lifted from HF LFS metadata. */
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** Size on disk for this shard. */
  sizeBytes: z.number().int().positive(),
});
export const ChatModelLlamaCppSourceSchema = z
  .object({
    /** Hugging Face repo id, e.g. `ggml-org/gemma-4-E2B-it-GGUF`. */
    huggingfaceRepo: z.string().regex(/^[A-Za-z0-9_\-.]+\/[A-Za-z0-9_\-.]+$/),
    /**
     * Git revision (commit SHA, tag, or branch) to download from. When
     * set, files are fetched from `…/resolve/<revision>/…` so the bytes
     * are immutable and the pinned `sha256`s always match — upstream
     * re-publishes to `main` can't drift us. Captured at catalog-build
     * time alongside the sha256 pins (both describe the same snapshot).
     * Optional for backward compatibility: absent → download from
     * `main` (the legacy behavior, where an upstream update can cause a
     * checksum mismatch). Prefer a full 40-char commit SHA; a branch
     * name re-introduces drift and a tag can be force-moved.
     */
    revision: z.string().optional(),
    /** Single-file form: filename within the repo, e.g. `gemma-4-E2B-it-Q4_K_M.gguf`. */
    filename: z.string().optional(),
    /** Single-file form: SHA-256 of the GGUF file, verified after download. */
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    /**
     * Sharded form: ordered list of GGUF shards. Order is significant —
     * the installer downloads sequentially, names on disk preserve the
     * `-NNNNN-of-NNNNN` suffix, and the first entry is what gets passed
     * to llama-server via `--model` (it discovers the rest by pattern).
     */
    shards: z.array(ShardEntrySchema).min(2).optional(),
    /** Total on-disk size: the GGUF for single-file, sum of all shards for sharded. */
    approxSizeBytes: z.number().int().positive(),
    /**
     * Working-set footprint when loaded, **KV cache EXCLUDED**: weights as
     * the engine actually buffers them, plus its compute/output buffers and
     * process cost. Used by the local-engine capacity broker to decide how
     * many models fit concurrently; it prices KV explicitly on top from the
     * launch context (see `mlxPlannedReservationBytes` in the MLX builder).
     *
     * Folding KV in here double-counts it. This field used to be documented
     * as "weights + KV cache at default context", and the pins authored to
     * that reading carried a flat 1.2-1.3x that was mostly KV — worth ~10 GiB
     * of phantom reservation on a 35B, while still under-reserving small
     * models whose real overhead is a fixed process cost.
     *
     * Optional, and only worth setting when someone has MEASURED this model:
     * absent entries fall back to `estimateLlamaCppResidentBytes` /
     * `estimateMlxResidentBytes`, which are themselves measured (see their
     * comments in model-fit.ts) and improve as the fleet is re-measured. A
     * pin that merely restates the formula is drift waiting to happen.
     */
    residentBytes: z.number().int().positive().optional(),
    /** Short quant tag for display ('Q4_K_M', 'Q8_0', 'BF16'). */
    quantization: z.string().optional(),
    /**
     * Optional multimodal projection sidecar. Multimodal GGUFs (LLaVA,
     * Gemma 4 vision, Nemotron-3 Omni, …) ship an extra projector file
     * alongside the LLM weights; llama-server loads it via
     * `--mmproj <path>` and the model can then accept image / audio /
     * video inputs. Absent → text-only install.
     *
     * Lives in the same HF repo as the weights, downloaded into the
     * same model directory, verified the same way. The installer
     * records its filename in the on-disk install manifest so the
     * supervisor knows to append `--mmproj` on launch.
     */
    mmproj: z
      .object({
        /** Filename within the repo, e.g. `mmproj-<model>-BF16.gguf`. */
        filename: z.string(),
        /** SHA-256 of the mmproj file, lifted from HF LFS metadata. */
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        /** Size on disk after download. */
        sizeBytes: z.number().int().positive(),
      })
      .optional(),
    /**
     * Optional speculative-decoding companion GGUF. Some model families
     * (notably Gemma 4) publish their MTP assistant head as a separate
     * model rather than embedding it in the primary GGUF. llama-server
     * loads this file through `--spec-draft-model`.
     *
     * This is deliberately generic: the tuning block selects the matching
     * `draft-mtp`, `draft-dflash`, or other draft mode. Merely shipping a
     * sidecar does not opt a model into a speculative-decoding algorithm.
     */
    draftModel: z
      .object({
        /** Filename within the same HF repo. May include a subdirectory. */
        filename: z.string(),
        /** SHA-256 of the draft GGUF, lifted from HF LFS metadata. */
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        /** Size on disk after download. */
        sizeBytes: z.number().int().positive(),
      })
      .optional(),
  })
  .refine(
    (v) => {
      const single = Boolean(v.filename) && Boolean(v.sha256);
      const sharded = Array.isArray(v.shards) && v.shards.length >= 2;
      return single !== sharded;
    },
    {
      message: 'llamaCpp source must set exactly one of (filename + sha256) or shards[] (>=2)',
    },
  );
export type ChatModelLlamaCppSource = z.infer<typeof ChatModelLlamaCppSourceSchema>;

/**
 * Per-entry ds4 (DwarfStar) source. ds4 loads supported routed-MoE GGUFs
 * (including DeepSeek V4 and GLM 5.2, single-file or sharded), so the shape mirrors
 * {@link ChatModelLlamaCppSourceSchema} — HF repo + revision + filename/shards
 * + sha256 + residentBytes + quantization — plus two ds4-specific SSD-
 * streaming hints. ds4 is NOT a general GGUF loader: use this block only for
 * architectures/quants the engine explicitly supports. Stock llama.cpp cannot
 * load the routed ds4-only quants.
 */
export const ChatModelDs4SourceSchema = z
  .object({
    /** Hugging Face repo id, e.g. `antirez/deepseek-v4-gguf`. */
    huggingfaceRepo: z.string().regex(/^[A-Za-z0-9_\-.]+\/[A-Za-z0-9_\-.]+$/),
    /** Git revision (commit SHA) for immutable, sha256-stable downloads. */
    revision: z.string().optional(),
    /** Single-file form: filename within the repo. */
    filename: z.string().optional(),
    /** Single-file form: SHA-256 of the GGUF, verified after download. */
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    /** Sharded form: ordered list of GGUF shards (first is passed to ds4 --model). */
    shards: z.array(ShardEntrySchema).min(2).optional(),
    /** Total on-disk size (the GGUF, or sum of shards). */
    approxSizeBytes: z.number().int().positive(),
    /**
     * Streaming working-set footprint (expert-cache budget + KV + resident
     * non-routed weights) — NOT the on-disk weight size. ds4 streams MoE
     * experts from SSD, so this is what the capacity broker bills, decoupled
     * from `approxSizeBytes`. Absent → broker falls back to a conservative
     * streaming default (see `CapacityBroker.estimateResidentBytes('ds4')`),
     * so a 64GB box is never told an 87GB DeepSeek-V4 model can't fit.
     *
     * This is a footprint at ONE context window — {@link residentCtxTokens}.
     * Pair it with {@link kvBytesPerToken} to price any other window.
     */
    residentBytes: z.number().int().positive().optional(),
    /**
     * Resident bytes each context token costs: ds4's compressed KV rows plus
     * the context buffers that scale with the window. ds4-server prints the
     * split at load —
     * `memory: KV 1.36 GiB (raw 0.36 + compressed 1.00) + buffers 1.00 GiB + …`
     * with `memory detail: ctx=… compressed_kv_rows=…` beneath it — so author
     * this from a real launch, not from an architecture guess.
     *
     * ds4 spills COLD context to SSD, which is why the slope is far below a
     * llama.cpp-class KV: DeepSeek V4 Flash's DSA costs ~8 KiB/token where
     * GLM 5.2's MLA costs ~89 KiB/token. Absent → the footprint is treated as
     * flat and the UI says so instead of drawing a line it can't justify.
     */
    kvBytesPerToken: z.number().int().positive().optional(),
    /**
     * The launch `--ctx` {@link residentBytes} was measured at. Only meaningful
     * alongside {@link kvBytesPerToken}: together they re-base the authored
     * footprint onto whatever window this device actually launches with —
     * `residentBytes + kvBytesPerToken × (ctx − residentCtxTokens)`.
     */
    residentCtxTokens: z.number().int().positive().optional(),
    /** Short quant tag for display ('IQ2_XXS', 'Q4_K', …). */
    quantization: z.string().optional(),
    /**
     * Suggested `--ssd-streaming-cache-experts` budget in bytes for this
     * quant. Drives both the launch flag and the resident estimate on
     * machines that can't hold the full weights. Absent → ds4 auto-sizes.
     */
    cacheExpertsBytes: z.number().int().positive().optional(),
    /**
     * Whether SSD streaming is recommended for this quant on sub-residency
     * machines (e.g. a 64GB Mac for the 87GB IQ2_XXS). Informational — the
     * runtime decides per actual device RAM.
     */
    ssdStreaming: z.boolean().optional(),
    /**
     * Ceiling on the launch-time `--ctx` window, in tokens. ds4's default is
     * RAM-tiered, which assumes DeepSeek-V4's small resident footprint; a
     * model that keeps far more weight resident needs a smaller window so KV
     * plus the expert cache still fit. GLM 5.2 IQ2_XXS holds 19.6 GiB of
     * non-routed weights (vs ~4 GiB for DeepSeek V4 Flash) and spends
     * 89 KiB/token on MLA KV, so the RAM-tiered 128K would claim 11 GiB of KV
     * on top of an already-5x-larger fixed cost. Absent → the RAM-tiered
     * default. An explicit `config.ds4NumCtx` always wins over this.
     */
    maxLaunchCtx: z.number().int().positive().optional(),
  })
  .refine(
    (v) => {
      const single = Boolean(v.filename) && Boolean(v.sha256);
      const sharded = Array.isArray(v.shards) && v.shards.length >= 2;
      return single !== sharded;
    },
    {
      message: 'ds4 source must set exactly one of (filename + sha256) or shards[] (>=2)',
    },
  );
export type ChatModelDs4Source = z.infer<typeof ChatModelDs4SourceSchema>;

/**
 * Per-entry MLX source. MLX models ship as a directory of files
 * (`config.json`, `tokenizer.json`, one or more `.safetensors` shards),
 * so the manifest pins each file's sha256 individually and the
 * installer downloads them as a batch. Apple Silicon only — `MlxProvider`
 * errors actionably on other platforms.
 */
function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

const ContainedPosixModelPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.includes('\\') &&
      !containsAsciiControlCharacter(path) &&
      !path.startsWith('/') &&
      path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    'path must be a contained POSIX-style relative path',
  );

export const ChatModelMlxSourceSchema = z
  .object({
    /** Hugging Face repo id, e.g. `mlx-community/gemma-4-e4b-it-4bit`. */
    huggingfaceRepo: z.string().regex(/^[A-Za-z0-9_\-.]+\/[A-Za-z0-9_\-.]+$/),
    /**
     * Optional model root inside a multi-build Hugging Face repository, e.g.
     * `6bit`. Remote files are fetched below this directory, while their
     * manifest `name`s are installed relative to the selected model root so
     * `config.json` still lands at the local model directory root.
     */
    subdir: ContainedPosixModelPathSchema.optional(),
    /**
     * Git revision (commit SHA, tag, or branch) to download from. When
     * set, files are fetched from `…/resolve/<revision>/…` so the bytes
     * are immutable and the pinned `sha256`s always match — upstream
     * re-publishes to `main` can't drift us. Captured at catalog-build
     * time alongside the sha256 pins (both describe the same snapshot).
     * Optional for backward compatibility: absent → download from `main`
     * (the legacy behavior, where an upstream update can cause a checksum
     * mismatch). Prefer a full 40-char commit SHA; a branch name
     * re-introduces drift and a tag can be force-moved.
     */
    revision: z.string().optional(),
    /**
     * Files to download from the selected model root, each with an
     * LFS-derived sha256. Names are contained, POSIX-style paths relative to
     * that root; they may preserve nested model layout but cannot escape the
     * install directory. Order is significant for progress reporting but not
     * for install correctness.
     */
    files: z
      .array(
        z.object({
          name: ContainedPosixModelPathSchema,
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          sizeBytes: z.number().int().positive(),
        }),
      )
      .min(1),
    /** Total on-disk size across all files. */
    approxSizeBytes: z.number().int().positive(),
    /**
     * Working-set footprint when loaded: weights + KV cache at default
     * context + activations + Metal buffers. Used by the local-engine
     * capacity broker. MLX's KV grows linearly with sequence length, so
     * this is typically a bigger multiplier of `approxSizeBytes` than
     * the llama.cpp equivalent. Optional — absent entries fall back to
     * `Math.round(approxSizeBytes * 1.30)`.
     */
    residentBytes: z.number().int().positive().optional(),
    /** Short quant tag for display (`4bit`, `8bit`, `bf16`). */
    quantization: z.string().optional(),
    /**
     * Last-resort Jinja chat template to inject into `tokenizer_config.json`
     * when the downloaded tokenizer_config has no `chat_template` and no
     * `chat_template.jinja` sidecar is shipped alongside. Some MLX
     * uploads omit the template that the upstream model was trained
     * against — without it `mlx_lm.server` falls back to a generic
     * template that may not match, and responses degrade from subtly
     * off to fully incoherent. The install pipeline's recovery order is:
     *   1. `tokenizer_config.chat_template` (upstream ships it) — use as is.
     *   2. `chat_template.jinja` sidecar downloaded from the repo — merge
     *      into tokenizer_config.
     *   3. This field, if set — merge into tokenizer_config.
     *   4. None — mark `chatTemplatePresent: false` and warn.
     */
    chatTemplate: z.string().optional(),
    /**
     * When set, this MLX build is KNOWN NOT TO LOAD/RUN and must be treated
     * as if the model had no MLX source — hidden from the MLX install picker,
     * refused by the install endpoint, and reported `mlx: false` by source
     * probes — even though the repo/sha pins are retained for the day an
     * upstream fix lands. The string is the human-readable reason (shown in
     * logs / advanced UI). Use this instead of DELETING the `mlx` block when
     * the incompatibility is expected to be temporary (an mlx-vlm arch/quant
     * gap), so the repo pin isn't lost.
     */
    disabledReason: z.string().optional(),
  })
  .superRefine((source, ctx) => {
    const seen = new Set<string>();
    source.files.forEach((file, index) => {
      if (seen.has(file.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['files', index, 'name'],
          message: `duplicate MLX install path: ${file.name}`,
        });
      }
      seen.add(file.name);
    });
  });
export type ChatModelMlxSource = z.infer<typeof ChatModelMlxSourceSchema>;

export const ChatModelIdentitySchema = IdentityCommonSchema.extend({
  kind: z.literal('chat-model'),
  /**
   * Organization that created the core model weights when it differs from
   * the catalog maintainer (for example, a quant maintained by its converter).
   * Omit when `maintainer` already names the maker.
   */
  maker: z
    .object({
      name: z.string().min(1),
      url: z.string().url().optional(),
    })
    .optional(),
  parameterSize: z.string(),
  supportsTools: z.boolean(),
  contextWindow: z.number().int().positive().optional(),
  /**
   * KV-cache geometry, mirrored from the resolved manifest. Lives on
   * IDENTITY rather than on a version because it is architecture-determined
   * and therefore identical across every quant of a model — and because the
   * catalog index is built from identity fields, so a value authored only on
   * the resolved shape is silently stripped and never reaches a pre-install
   * fit badge. See {@link ChatModelManifestSchema} for the semantics.
   */
  kvBytesPerTokenF16: z.number().positive().optional(),
  kvFixedBytesF16: z.number().nonnegative().optional(),
  upstream: z.string().url().optional(),
  /** Coarse specialty used by the UI filter tabs. */
  category: ChatModelCategorySchema.optional(),
  /**
   * Descriptive style declaration — family, reasoning format, tool-call
   * format. Drives runtime decisions like which strip patterns to apply
   * and which system-prompt hint to emit. Optional so existing manifests
   * parse unchanged; the runtime falls back to a tier-based default
   * when absent. See {@link ModelStyleSchema}.
   */
  style: ModelStyleSchema.optional(),
  /**
   * Prescriptive behavior opt-ins — IDs that key into the runtime's
   * behavior registry. Each entry is either a bare ID (the common case
   * for switch-style behaviors) or `{ id, config }` when the behavior
   * takes parameters. Optional; absent → tier-default behavior set.
   * See {@link BehaviorEntrySchema}.
   */
  behaviors: z.array(BehaviorEntrySchema).optional(),
  /**
   * Per-model recommended sampling / reasoning / structured-output
   * defaults. Identity-level (stable across quantizations). Resolved
   * at request time via the service's `resolveTuning` helper, which
   * merges gezel-frontmatter override > this block > provider fallback.
   * See {@link ChatModelTuningSchema}.
   */
  tuning: ChatModelTuningSchema.optional(),
});
export type ChatModelIdentity = z.infer<typeof ChatModelIdentitySchema>;

export const ChatModelVersionManifestSchema = z.object({
  ...MinGezelVersionShape,
  schemaVersion: z.literal(1),
  version: z.string().regex(SemverRegex),
  releasedAt: z.string(),
  /**
   * Informational default size for display. Per-source sizes can
   * diverge (Ollama ships a specific quant; llama.cpp pulls a
   * specific file) — consumers should prefer the per-source number
   * when available.
   */
  approxSizeBytes: z.number().int().positive(),
  /** Ollama pull source. Optional — some entries are llama-cpp-only. */
  ollama: ChatModelOllamaSourceSchema.optional(),
  /** llama.cpp GGUF source. Optional — some entries are Ollama-only. */
  llamaCpp: ChatModelLlamaCppSourceSchema.optional(),
  /** MLX source — Apple Silicon only. Optional. */
  mlx: ChatModelMlxSourceSchema.optional(),
  /** ds4 (DwarfStar) source — DeepSeek-V4 GGUFs, Metal/CUDA only. Optional. */
  ds4: ChatModelDs4SourceSchema.optional(),
  notes: z.string().optional(),
});
export type ChatModelVersionManifest = z.infer<typeof ChatModelVersionManifestSchema>;

/**
 * Per-model eval-harness hints. Schema-present so manifests can declare
 * them; production code paths ignore the block entirely. Two
 * `sniffThresholds` overrides are supported: `inlineJsMinBytes` — a
 * per-model override for the shared anti-stub JS floor (default 2048)
 * used by the interactive-game scenarios (`tictactoe`, `tankcombat`);
 * and `htmlMinBytes` — the parallel per-model override for the shared
 * total-HTML floor (`MIN_GAME_HTML_BYTES`, default 4096) used by the
 * canvas-game `html-size-ok` signal (`tankcombat`, `arcade-deluxe`).
 * The fields exist because some model families (Nemotron-3, GPT-OSS, …)
 * write idiomatically tight functional code that lands just under the
 * default thresholds; calibrating per-family is more honest than
 * pretending one floor fits every model's style.
 */
export const EvalHintsSchema = z.object({
  sniffThresholds: z
    .object({
      /**
       * Override `MIN_INLINE_JS_BYTES` (default 2048) for THIS model when
       * the interactive-game scenarios check `js-size-ok`. Lower values
       * accept tighter idiomatic implementations; the eval harness
       * still clamps to a sane floor (~1000 B) to keep "empty stub"
       * filtering intact.
       */
      inlineJsMinBytes: z.number().int().min(1000).optional(),
      /**
       * Override `MIN_GAME_HTML_BYTES` (default 4096) for THIS model when
       * the canvas-game scenarios check `html-size-ok`. Lower values
       * accept terser-but-complete games (e.g. GPT-OSS ~2.6 KB,
       * Nemotron-nano ~4 KB) whose total HTML lands under the shared
       * floor; the eval harness still clamps to a sane floor (~1000 B)
       * and the 4-of-6 keyword + js-parses + js-size-ok signals keep
       * "empty stub" filtering intact.
       */
      htmlMinBytes: z.number().int().min(1000).optional(),
    })
    .optional(),
});
export type EvalHints = z.infer<typeof EvalHintsSchema>;

export const ChatModelManifestSchema = z.object({
  ...MinGezelVersionShape,
  schemaVersion: z.literal(1),
  kind: z.literal('chat-model'),
  id: z.string().regex(IdRegex),
  name: z.string().min(1),
  description: z.string(),
  tags: z.array(z.string()).default([]),
  maintainer: z.object({
    name: z.string(),
    url: z.string().url().optional(),
  }),
  /** Core-model maker; present when it differs from `maintainer`. */
  maker: z
    .object({
      name: z.string().min(1),
      url: z.string().url().optional(),
    })
    .optional(),
  logo: z.string().optional(),
  license: z.string().optional(),
  ...LicenseMetaShape,
  ...RecoMetaShape,
  version: z.string(),
  releasedAt: z.string(),
  parameterSize: z.string(),
  approxSizeBytes: z.number().int().positive(),
  supportsTools: z.boolean(),
  contextWindow: z.number().int().positive().optional(),
  /**
   * KV-cache slope at f16, bytes per context token — the windowed-cache
   * slope for sliding-window models, the full-attention per-token cost
   * otherwise. Architecture-determined (same across quants). Lets
   * install-time fit badges price weights + KV at the practical 64K
   * window BEFORE the weights are on disk — a small dense model's KV can
   * exceed its weights, and a weights-only fit badge says "fits" on a
   * machine the post-install admission will refuse.
   */
  kvBytesPerTokenF16: z.number().positive().optional(),
  /** Context-independent KV bytes at f16 (SWA window blocks); pairs with `kvBytesPerTokenF16`. */
  kvFixedBytesF16: z.number().nonnegative().optional(),
  upstream: z.string().url().optional(),
  category: ChatModelCategorySchema.optional(),
  /** Style + behaviors + tuning flow through from {@link ChatModelIdentitySchema}. */
  style: ModelStyleSchema.optional(),
  behaviors: z.array(BehaviorEntrySchema).optional(),
  tuning: ChatModelTuningSchema.optional(),
  /**
   * Eval-harness-only metadata. Production code paths MUST NOT read
   * this; it exists to let the eval suite calibrate sniff thresholds
   * per-model when a model's natural output style differs systematically
   * from what the default scenario thresholds assume. Wild-caught
   * (nemotron-super tictactoe): the model writes
   * idiomatically tight code that lands at 1996 bytes of inline JS,
   * 52 bytes under the scenario's anti-stub floor of 2048. Lowering
   * the floor to 1500 for nemotron is honest accommodation — the model
   * IS delivering working games, the threshold was calibrated against
   * a different family's output norms.
   */
  evalHints: EvalHintsSchema.optional(),
  ollama: ChatModelOllamaSourceSchema.optional(),
  llamaCpp: ChatModelLlamaCppSourceSchema.optional(),
  mlx: ChatModelMlxSourceSchema.optional(),
  ds4: ChatModelDs4SourceSchema.optional(),
  notes: z.string().optional(),
  availableVersions: z.array(z.string()).default([]),
});
// Invariant: at least one source block must be set on the version
// payload. Enforced at catalog-load time (see
// packages/catalog/src/source.ts) rather than via .refine() because
// .refine wraps the schema in ZodEffects, which can't live inside a
// discriminated union.
export type ChatModelManifest = z.infer<typeof ChatModelManifestSchema>;

// ─ Image-gen model recommendations (stable-diffusion.cpp et al) ─────

export const ImageModelCategorySchema = z.enum(['general', 'artistic', 'photographic']);
export type ImageModelCategory = z.infer<typeof ImageModelCategorySchema>;

/**
 * Coarse hardware tier for the model. Drives a "Runs on … memory" pill in
 * the catalog UI and (later) RAM-budget filtering analogous to
 * `LlamaCppModelManager`. The numeric `minRamGB` carried alongside is the
 * actual machine-readable signal; the tier is the human-friendly bucket.
 */
export const ImageModelHardwareTierSchema = z.enum(['low', 'mid', 'high', 'workstation']);
export type ImageModelHardwareTier = z.infer<typeof ImageModelHardwareTierSchema>;

/**
 * Stable-diffusion.cpp's launch flags for files external to the unet:
 *   --vae, --clip_l, --clip_g, --t5xxl, --llm
 * FLUX and SD3 distributions ship these as separate downloads because the
 * unet is quantized but the encoders/VAE are not, and bundling them all
 * would waste bandwidth for users mixing-and-matching quants.
 *
 * `llm` is the role for FLUX.2-class models that swap the T5+CLIP encoder
 * pair for a full LLM text encoder (Qwen3-4B for FLUX.2 Klein 4B,
 * Mistral-Small-3.2 for FLUX.2 dev). sd-cpp's `--llm <path>` flag accepts
 * a GGUF. The aux role name maps 1:1 onto the sd-server flag name, so
 * adding the enum value here is enough — no launcher code change needed.
 */
export const ImageModelAuxiliaryRoleSchema = z.enum(['vae', 'clip_l', 'clip_g', 't5xxl', 'llm']);
export type ImageModelAuxiliaryRole = z.infer<typeof ImageModelAuxiliaryRoleSchema>;

export const ImageModelAuxiliaryFileSchema = z.object({
  role: ImageModelAuxiliaryRoleSchema,
  downloadUrl: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  approxSizeBytes: z.number().int().positive(),
});
export type ImageModelAuxiliaryFile = z.infer<typeof ImageModelAuxiliaryFileSchema>;

export const ImageModelIdentitySchema = IdentityCommonSchema.extend({
  kind: z.literal('image-model'),
  /** Recommended sampler steps; the generate endpoint falls back to this. */
  recommendedSteps: z.number().int().positive().default(20),
  widthRange: z
    .object({ min: z.number().int().positive(), max: z.number().int().positive() })
    .optional(),
  heightRange: z
    .object({ min: z.number().int().positive(), max: z.number().int().positive() })
    .optional(),
  upstream: z.string().url().optional(),
  category: ImageModelCategorySchema.optional(),
  /**
   * `checkpoint` — single-file model loaded via sd-server `--model` (SD 1.x,
   * SDXL, SD 3.5 full). `diffusion-model` — unet-only loaded via
   * `--diffusion-model` and combined with auxiliary files passed via
   * `--vae` / `--clip_l` / `--clip_g` / `--t5xxl` (FLUX, SD3 GGUF).
   */
  weightsKind: z.enum(['checkpoint', 'diffusion-model']).default('checkpoint'),
  /**
   * Whether this model supports image-to-image (editing a source image via
   * sd-server's `/sdapi/v1/img2img`). Explicit catalog declaration — when
   * absent, the service falls back to its per-model assessment map and then
   * to a `weightsKind`-based default (classic checkpoints support img2img;
   * unverified diffusion-model architectures are treated as txt2img-only).
   * See `resolveImg2ImgSupport` in the service's image provider layer.
   */
  supportsImg2Img: z.boolean().optional(),
  /** Coarse hardware tier — drives the "runs on …" pill. */
  hardwareTier: ImageModelHardwareTierSchema,
  /** Minimum recommended unified-memory / VRAM in gigabytes. */
  minRamGB: z.number().positive(),
  /**
   * Whether the upstream license permits commercial use. When false, the
   * UI shows a prominent "Non-commercial" badge so the user makes an
   * informed choice (e.g. SDXL Turbo, FLUX.1-dev).
   */
  commercialUse: z.boolean(),
});
export type ImageModelIdentity = z.infer<typeof ImageModelIdentitySchema>;

export const ImageModelVersionManifestSchema = z.object({
  ...MinGezelVersionShape,
  schemaVersion: z.literal(1),
  version: z.string().regex(SemverRegex),
  releasedAt: z.string(),
  /** Direct URL to the model weights file (`.gguf` / `.safetensors`). */
  downloadUrl: z.string().url(),
  /** SHA-256 of the weights file; verified after download. */
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  approxSizeBytes: z.number().int().positive(),
  /** e.g. 'Q4_K_M', 'Q8_0', 'F16'. Informational. */
  quantization: z.string().optional(),
  /**
   * Auxiliary files required alongside the unet for `diffusion-model`
   * weights. Empty for traditional checkpoints. Each file is downloaded
   * with the same sha256-pinned pipeline as the main weights.
   */
  auxiliaryFiles: z.array(ImageModelAuxiliaryFileSchema).default([]),
  notes: z.string().optional(),
});
export type ImageModelVersionManifest = z.infer<typeof ImageModelVersionManifestSchema>;

export const ImageModelManifestSchema = z.object({
  ...MinGezelVersionShape,
  schemaVersion: z.literal(1),
  kind: z.literal('image-model'),
  id: z.string().regex(IdRegex),
  name: z.string().min(1),
  description: z.string(),
  tags: z.array(z.string()).default([]),
  maintainer: z.object({
    name: z.string(),
    url: z.string().url().optional(),
  }),
  logo: z.string().optional(),
  license: z.string().optional(),
  ...LicenseMetaShape,
  ...RecoMetaShape,
  version: z.string(),
  releasedAt: z.string(),
  downloadUrl: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  approxSizeBytes: z.number().int().positive(),
  quantization: z.string().optional(),
  recommendedSteps: z.number().int().positive().default(20),
  widthRange: z
    .object({ min: z.number().int().positive(), max: z.number().int().positive() })
    .optional(),
  heightRange: z
    .object({ min: z.number().int().positive(), max: z.number().int().positive() })
    .optional(),
  upstream: z.string().url().optional(),
  category: ImageModelCategorySchema.optional(),
  weightsKind: z.enum(['checkpoint', 'diffusion-model']).default('checkpoint'),
  /** Mirrors {@link ImageModelIdentitySchema.supportsImg2Img}. */
  supportsImg2Img: z.boolean().optional(),
  auxiliaryFiles: z.array(ImageModelAuxiliaryFileSchema).default([]),
  hardwareTier: ImageModelHardwareTierSchema,
  minRamGB: z.number().positive(),
  commercialUse: z.boolean(),
  notes: z.string().optional(),
  availableVersions: z.array(z.string()).default([]),
});
export type ImageModelManifest = z.infer<typeof ImageModelManifestSchema>;

// ─ Video models ─────────────────────────────────────────────────────

/**
 * Generative video model family. Drives which family of `diffusers`
 * pipelines the Python engine constructs and which conditioning the UI
 * exposes:
 *   - `ltx`  → LTX-Video 0.9.x (`LTXPipeline` / `LTXConditionPipeline`),
 *              T5 text encoder, video-only.
 *   - `ltx2` → LTX-2 / LTX-2.3 (`LTX2Pipeline` / `LTX2ConditionPipeline`),
 *              Gemma3 text encoder, emits a synchronized audio track.
 *   - `wan`  → WAN 2.x (`WanPipeline`), float32 VAE.
 * The exact pipeline class within a family can be pinned per-model via
 * {@link VideoModelLoadSchema.pipelineClass} — two `ltx` models can want
 * different classes (the 2B base wants `LTXPipeline`, the 0.9.7 models
 * `LTXConditionPipeline`). Kept small and explicit — a new family is a
 * code change in the engine, not just catalog data.
 */
export const VideoModelFamilySchema = z.enum(['ltx', 'ltx2', 'wan']);
export type VideoModelFamily = z.infer<typeof VideoModelFamilySchema>;

/**
 * How the engine assembles the diffusers pipeline for a model. Lets the
 * catalog drive loading without an engine code change per checkpoint:
 *
 *   - `diffusers-tree` (default): the install is a full diffusers repo
 *     (`model_index.json` + component subfolders); load with
 *     `Pipeline.from_pretrained(modelDir)`.
 *   - `single-file`: the install is one transformer checkpoint
 *     (`singleFileName`) plus the rest of the pipeline's components in
 *     subfolders (downloaded from a reference repo via per-file
 *     {@link VideoModelSourceSchema} `repo` overrides). The engine builds
 *     the transformer with `from_single_file` and grafts it onto the
 *     components. This is how the LTX-2.3 22B fp8 checkpoint loads against
 *     the LTX-2 component stack.
 */
export const VideoModelLoadSchema = z.object({
  strategy: z.enum(['diffusers-tree', 'single-file']).default('diffusers-tree'),
  /**
   * Concrete diffusers pipeline class, e.g. `LTXConditionPipeline`,
   * `LTX2Pipeline`. Overrides the engine's family default and any
   * `_class_name` in `model_index.json` (which the 0.9.7/0.9.8 repos
   * omit). Required in practice for anything but the legacy base model.
   */
  pipelineClass: z.string().optional(),
  /** `single-file`: the transformer checkpoint filename in the install dir. */
  singleFileName: z.string().optional(),
  /** `single-file`: the diffusers model class to convert the checkpoint into. */
  transformerClass: z.string().optional(),
  /**
   * Precision to load the VAE at, independent of the transformer dtype.
   * WAN and LTX-2 decode to washed-out / banded frames unless their VAE
   * runs in float32. Absent → the engine's family default.
   */
  vaeDtype: z.enum(['float32', 'bfloat16']).optional(),
  /**
   * The pipeline emits a synchronized audio track (LTX-2 family) that the
   * engine muxes into the MP4. Video-only families leave this false.
   */
  audio: z.boolean().default(false),
});
export type VideoModelLoad = z.infer<typeof VideoModelLoadSchema>;

/**
 * Per-entry video-model source. Like MLX chat models, generative video
 * models ship as a Hugging Face repo of many files (a `model_index.json`,
 * per-component `config.json`s, VAE / transformer / text-encoder
 * shards), so the manifest pins each file's sha256 individually and the
 * installer downloads them as a batch with the shared multi-file puller.
 */
export const VideoModelSourceSchema = z.object({
  /** Hugging Face repo id, e.g. `Lightricks/LTX-Video`. */
  huggingfaceRepo: z.string().regex(/^[A-Za-z0-9_\-.]+\/[A-Za-z0-9_\-.]+$/),
  /**
   * Git revision (commit SHA, tag, or branch) to download from. When
   * set, files are fetched from `…/resolve/<revision>/…` so the pinned
   * `sha256`s always match. Prefer a full 40-char commit SHA; absent →
   * download from `main` (legacy, drift-prone). Mirrors
   * {@link ChatModelMlxSourceSchema.revision}.
   */
  revision: z.string().optional(),
  /**
   * Files to download from the repo, each with an LFS-derived sha256.
   * Order matters for progress reporting only. The full diffusers repo
   * layout is preserved on disk (subdirectories included via `name`),
   * so `from_pretrained(modelDir)` loads without rewrites.
   */
  files: z
    .array(
      z.object({
        /** Repo-relative path, e.g. `transformer/diffusion_pytorch_model.safetensors`. */
        name: z.string(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        sizeBytes: z.number().int().positive(),
        /**
         * Override the source-level `huggingfaceRepo`/`revision` for this
         * one file. Lets a single install assemble files from more than one
         * repo — e.g. the LTX-2.3 transformer checkpoint from
         * `Lightricks/LTX-2.3-fp8` alongside the VAE / text-encoder /
         * vocoder components pinned from `Lightricks/LTX-2`. Absent → the
         * file comes from the source-level repo at the source revision.
         */
        repo: z
          .string()
          .regex(/^[A-Za-z0-9_\-.]+\/[A-Za-z0-9_\-.]+$/)
          .optional(),
        revision: z.string().optional(),
      }),
    )
    .min(1),
  /** Total on-disk size across all files. */
  approxSizeBytes: z.number().int().positive(),
  /** Short quant/precision tag for display (`bf16`, `fp8`). */
  quantization: z.string().optional(),
});
export type VideoModelSource = z.infer<typeof VideoModelSourceSchema>;

const FrameRangeSchema = z.object({
  min: z.number().int().positive(),
  max: z.number().int().positive(),
});

export const VideoModelIdentitySchema = IdentityCommonSchema.extend({
  kind: z.literal('video-model'),
  /** Pipeline family the engine builds for this model. */
  family: VideoModelFamilySchema,
  /** How the engine assembles the pipeline (tree vs single-file, class, etc.). */
  load: VideoModelLoadSchema.optional(),
  /** Recommended sampler steps; the generate endpoint falls back to this. */
  recommendedSteps: z.number().int().positive().default(40),
  /**
   * Classifier-free guidance scale default. Distilled few-step models
   * want a low value (≈1); dev models a higher one (≈3). The generate
   * endpoint falls back to this when the caller doesn't pass one.
   */
  guidanceScale: z.number().positive().optional(),
  /** Default number of frames to render when the caller doesn't specify. */
  defaultNumFrames: z.number().int().positive().default(97),
  /** Allowed frame-count window (model-specific; LTX wants 8n+1). */
  numFramesRange: FrameRangeSchema.optional(),
  /** Default frames-per-second for the encoded clip. */
  defaultFps: z.number().int().positive().default(24),
  /** Allowed fps window. */
  fpsRange: FrameRangeSchema.optional(),
  /** Hard ceiling on requested duration, seconds. Guards OOM / runaway jobs. */
  maxDurationSeconds: z.number().positive().optional(),
  widthRange: FrameRangeSchema.optional(),
  heightRange: FrameRangeSchema.optional(),
  /**
   * Native default resolution to render at when the caller doesn't
   * specify one. Model-specific: LTX is happiest at 704×480, WAN 2.2
   * TI2V-5B at 1280×704 — generating WAN at LTX's default produces a
   * wrong-aspect, degraded clip, so each model declares its own.
   */
  defaultWidth: z.number().int().positive().optional(),
  defaultHeight: z.number().int().positive().optional(),
  /** Whether this model accepts an input image for image-to-video. */
  supportsImageToVideo: z.boolean().default(false),
  upstream: z.string().url().optional(),
  /** Reuses the image-model tier vocabulary for the "runs on …" pill. */
  hardwareTier: ImageModelHardwareTierSchema,
  /** Minimum recommended unified-memory / VRAM in gigabytes. */
  minVramGB: z.number().positive(),
  /** Whether the upstream license permits commercial use. */
  commercialUse: z.boolean(),
});
export type VideoModelIdentity = z.infer<typeof VideoModelIdentitySchema>;

export const VideoModelVersionManifestSchema = z.object({
  ...MinGezelVersionShape,
  schemaVersion: z.literal(1),
  version: z.string().regex(SemverRegex),
  releasedAt: z.string(),
  source: VideoModelSourceSchema,
  notes: z.string().optional(),
});
export type VideoModelVersionManifest = z.infer<typeof VideoModelVersionManifestSchema>;

export const VideoModelManifestSchema = z.object({
  ...MinGezelVersionShape,
  schemaVersion: z.literal(1),
  kind: z.literal('video-model'),
  id: z.string().regex(IdRegex),
  name: z.string().min(1),
  description: z.string(),
  tags: z.array(z.string()).default([]),
  maintainer: z.object({
    name: z.string(),
    url: z.string().url().optional(),
  }),
  logo: z.string().optional(),
  license: z.string().optional(),
  ...LicenseMetaShape,
  ...RecoMetaShape,
  version: z.string(),
  releasedAt: z.string(),
  family: VideoModelFamilySchema,
  /** How the engine assembles the pipeline (tree vs single-file, class, etc.). */
  load: VideoModelLoadSchema.optional(),
  source: VideoModelSourceSchema,
  approxSizeBytes: z.number().int().positive(),
  recommendedSteps: z.number().int().positive().default(40),
  /** Classifier-free guidance scale default (see identity schema). */
  guidanceScale: z.number().positive().optional(),
  defaultNumFrames: z.number().int().positive().default(97),
  numFramesRange: FrameRangeSchema.optional(),
  defaultFps: z.number().int().positive().default(24),
  fpsRange: FrameRangeSchema.optional(),
  maxDurationSeconds: z.number().positive().optional(),
  widthRange: FrameRangeSchema.optional(),
  heightRange: FrameRangeSchema.optional(),
  defaultWidth: z.number().int().positive().optional(),
  defaultHeight: z.number().int().positive().optional(),
  supportsImageToVideo: z.boolean().default(false),
  upstream: z.string().url().optional(),
  hardwareTier: ImageModelHardwareTierSchema,
  minVramGB: z.number().positive(),
  commercialUse: z.boolean(),
  notes: z.string().optional(),
  availableVersions: z.array(z.string()).default([]),
});
export type VideoModelManifest = z.infer<typeof VideoModelManifestSchema>;

// ─ Identity / version unions ────────────────────────────────────────

export const CatalogItemIdentitySchema = z.discriminatedUnion('kind', [
  ToolsetIdentitySchema,
  GezelTemplateIdentitySchema,
  CraftbookTemplateIdentitySchema,
  ProjectTypeIdentitySchema,
  ConnectorTypeIdentitySchema,
  ChatModelIdentitySchema,
  ImageModelIdentitySchema,
  VideoModelIdentitySchema,
]);
export type CatalogItemIdentity = z.infer<typeof CatalogItemIdentitySchema>;

// ─ Top-level resolved union + helpers ───────────────────────────────

export const CatalogItemManifestSchema = z.discriminatedUnion('kind', [
  ToolsetManifestSchema,
  GezelTemplateManifestSchema,
  CraftbookTemplateManifestSchema,
  ProjectTypeManifestSchema,
  ConnectorTypeManifestSchema,
  ChatModelManifestSchema,
  ImageModelManifestSchema,
  VideoModelManifestSchema,
]);
export type CatalogItemManifest = z.infer<typeof CatalogItemManifestSchema>;

export const CatalogKindSchema = z.enum([
  'toolset',
  'gezel-template',
  'craftbook-template',
  'project-type',
  'connector-type',
  'chat-model',
  'image-model',
  'video-model',
]);
export type CatalogKind = z.infer<typeof CatalogKindSchema>;

/**
 * What `listItems` returns — manifest plus provenance (which source the
 * item came from) and a resolved logo the UI can render. `iconSvg`
 * (when present) is preferred over `logoUrl` since `<img src>` from
 * the auth-gated `/api/catalog/.../file/...` endpoint can't carry the
 * bearer token; built-in toolsets embed their SVG directly here.
 */
export const CatalogItemSummarySchema = z.object({
  sourceId: z.string(),
  kind: CatalogKindSchema,
  manifest: CatalogItemManifestSchema,
  /** Public URL for the logo — served by the catalog HTTP route. */
  logoUrl: z.string().optional(),
  /** Inline SVG markup. Treat as untrusted until structurally sanitized; live/community catalogs can supply it. */
  iconSvg: z.string().optional(),
});
export type CatalogItemSummary = z.infer<typeof CatalogItemSummarySchema>;

export const ListCatalogItemsResponseSchema = z.object({
  items: z.array(CatalogItemSummarySchema),
});
export type ListCatalogItemsResponse = z.infer<typeof ListCatalogItemsResponseSchema>;

export const CatalogItemDetailSchema = CatalogItemSummarySchema.extend({
  /** Rendered README markdown, if present alongside the manifest. */
  readme: z.string().optional(),
  /** For gezel templates: the loaded about.md content. */
  about: z.string().optional(),
});
export type CatalogItemDetail = z.infer<typeof CatalogItemDetailSchema>;

/**
 * One entry in `listVersions` output. `yanked` reflects the identity
 * manifest's `yankedVersions[]` membership at read time.
 */
export const CatalogItemVersionInfoSchema = z.object({
  version: z.string(),
  releasedAt: z.string(),
  yanked: z.boolean(),
});
export type CatalogItemVersionInfo = z.infer<typeof CatalogItemVersionInfoSchema>;

export const ListCatalogItemVersionsResponseSchema = z.object({
  versions: z.array(CatalogItemVersionInfoSchema),
});
export type ListCatalogItemVersionsResponse = z.infer<typeof ListCatalogItemVersionsResponseSchema>;

/**
 * Record of a toolset installed in a toolsets (per-gezel or shared). Persisted
 * at `toolsets.json` for that toolsets. Config values live globally by
 * toolsetId in a separate file (see ToolsetConfigSchema); secrets live in
 * the SecretStore keyed by `(toolsetId, fieldId)`.
 */
const InstalledToolsetFields = {
  toolsetId: z.string(),
  sourceId: z.string(),
  version: z.string(),
  installedAt: z.string(),
  /** Local install path (for npm-package / stdio-mcp-binary kinds). */
  installPath: z.string().optional(),
};

const StandardInstalledToolsetSchema = z.object({
  ...InstalledToolsetFields,
  /** Snapshot of the runtime at install time — the live source of truth for spawning. */
  runtime: ToolsetRuntimeSchema,
});

/**
 * The system bootstrap pins npm tarballs with registry SRI strings (normally
 * SHA-512), rather than the catalog installer's SHA-256 hex digest. Existing
 * system records persist that stronger pin in the historical `sha256` slot.
 * Keep this compatibility shape scoped to `sourceId: 'system'` so catalog and
 * user-installed runtimes remain subject to the ordinary SHA-256 schema.
 */
const SystemNpmPackageRuntimeSchema = NpmPackageRuntimeSchema.extend({
  sha256: z
    .string()
    .regex(/^(?:sha256-[A-Za-z0-9+/]{43}=|sha384-[A-Za-z0-9+/]{64}|sha512-[A-Za-z0-9+/]{86}==)$/),
});

const SystemInstalledToolsetSchema = z.object({
  ...InstalledToolsetFields,
  sourceId: z.literal('system'),
  runtime: SystemNpmPackageRuntimeSchema,
});

export const InstalledToolsetSchema = z.union([
  StandardInstalledToolsetSchema,
  SystemInstalledToolsetSchema,
]);
export type InstalledToolset = z.infer<typeof InstalledToolsetSchema>;

/**
 * Global configuration for a toolset, keyed by toolsetId. One file per
 * toolset at `~/.gezel/toolsets/{toolsetId}/config.json`. Holds only
 * non-secret values; secret values live in the SecretStore.
 */
export const ToolsetConfigSchema = z.object({
  toolsetId: z.string(),
  values: z.record(z.string(), z.string()).default({}),
  updatedAt: z.string(),
});
export type ToolsetConfig = z.infer<typeof ToolsetConfigSchema>;

// ─ .gezapp AI App packages ─────────────────────────────────────────
//
// A `.gezapp` is a renamed ZIP containing one entry project type and the
// exact-version catalog items that make it self-contained: gezel roles and
// craftbooks. Toolsets, connectors, and models stay outside the archive and
// appear in the resolved dependency lock instead. The package manifest is an
// install receipt as well as the review surface; it is retained after import.

export const GezappEmbeddedKindSchema = z.enum([
  'project-type',
  'gezel-template',
  'craftbook-template',
]);
export type GezappEmbeddedKind = z.infer<typeof GezappEmbeddedKindSchema>;

export const GezappDependencyKindSchema = z.enum([
  'toolset',
  'connector-type',
  'chat-model',
  'image-model',
  'video-model',
]);
export type GezappDependencyKind = z.infer<typeof GezappDependencyKindSchema>;

/** One exact catalog item embedded in a `.gezapp`. Its path is derived. */
export const GezappItemSchema = z.object({
  kind: GezappEmbeddedKindSchema,
  id: z.string().regex(IdRegex),
  version: z.string().regex(SemverRegex),
  /** SHA-256 (hex) over the selected identity/shared files + exact version. */
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type GezappItem = z.infer<typeof GezappItemSchema>;

/** An exact external dependency resolved while the package was built. */
export const GezappDependencySchema = z.object({
  kind: GezappDependencyKindSchema,
  id: z.string().regex(IdRegex),
  version: z.string().regex(SemverRegex),
  required: z.boolean().default(true),
  sourceId: z.string().optional(),
  reason: z.string().optional(),
});
export type GezappDependency = z.infer<typeof GezappDependencySchema>;

export const GezappEntrySchema = z.object({
  projectType: z.string().regex(IdRegex),
  version: z.string().regex(SemverRegex),
});
export type GezappEntry = z.infer<typeof GezappEntrySchema>;

/** The root `manifest.json` of a `.gezapp` package. */
export const GezappManifestSchema = z
  .object({
    format: z.literal('gezel-ai-app'),
    schemaVersion: z.literal(1),
    entry: GezappEntrySchema,
    /** Review snapshot. Canonical identity remains the entry project type. */
    name: z.string().min(1),
    description: z.string().default(''),
    publisher: z.object({
      name: z.string().min(1),
      url: z.string().url().optional(),
    }),
    /** ISO timestamp stamped by the exporter. */
    createdAt: z.string().datetime(),
    /** Effective calendar-line floor across every embedded item. */
    minGezelVersion: z.string().optional(),
    /** v1 side-loaded packages are always explicit about being unsigned. */
    signature: z.object({ status: z.literal('unsigned') }),
    items: z.array(GezappItemSchema).min(1).max(512),
    dependencies: z.array(GezappDependencySchema).max(512).default([]),
    provenance: z
      .object({
        source: z.string().optional(),
        exportedFromProject: z.string().optional(),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    const keys = new Set<string>();
    for (const [index, item] of value.items.entries()) {
      const key = `${item.kind}:${item.id}`;
      if (keys.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['items', index],
          message: `duplicate embedded item ${key}`,
        });
      }
      keys.add(key);
    }
    const dependencyKeys = new Set<string>();
    for (const [index, dependency] of value.dependencies.entries()) {
      const key = `${dependency.kind}:${dependency.id}`;
      if (dependencyKeys.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['dependencies', index],
          message: `duplicate external dependency ${key}`,
        });
      }
      dependencyKeys.add(key);
    }
    const projectTypes = value.items.filter((item) => item.kind === 'project-type');
    if (projectTypes.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['items'],
        message: 'a .gezapp must contain exactly one project type',
      });
      return;
    }
    const entry = projectTypes[0]!;
    if (entry.id !== value.entry.projectType || entry.version !== value.entry.version) {
      ctx.addIssue({
        code: 'custom',
        path: ['entry'],
        message: 'entry must identify the embedded project type and exact version',
      });
    }
  });
export type GezappManifest = z.infer<typeof GezappManifestSchema>;

/** Durable record retained with an installed AI App version. */
export const GezappInstallReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  manifest: GezappManifestSchema,
  packageSha256: z.string().regex(/^[a-f0-9]{64}$/),
  installedAt: z.string().datetime(),
});
export type GezappInstallReceipt = z.infer<typeof GezappInstallReceiptSchema>;

export const GezappRegistryEntrySchema = z.object({
  appId: z.string().regex(IdRegex),
  version: z.string().regex(SemverRegex),
  packageSha256: z.string().regex(/^[a-f0-9]{64}$/),
  installedAt: z.string().datetime(),
  enabled: z.boolean().default(true),
});
export type GezappRegistryEntry = z.infer<typeof GezappRegistryEntrySchema>;

export const GezappRegistrySchema = z.object({
  schemaVersion: z.literal(1),
  apps: z.array(GezappRegistryEntrySchema).default([]),
});
export type GezappRegistry = z.infer<typeof GezappRegistrySchema>;

// ─ .gezmodel portable model bundles ──────────────────────────────────────
//
// A `.gezmodel` is a renamed ZIP containing a root `manifest.json`, the
// installed + catalog manifest snapshots Gezel used, and a `model/` folder
// with the model's data files. Every non-root entry is size- and SHA-256-
// pinned here so import can verify the complete archive before publishing a
// single byte into an engine's live model directory.

export const GezmodelEngineSchema = z.enum(['llama-cpp', 'mlx', 'ds4']);
export type GezmodelEngine = z.infer<typeof GezmodelEngineSchema>;

export const GezmodelFileSchema = z.object({
  /** POSIX-style path inside the ZIP (`model/foo.gguf`, `manifests/…`). */
  path: z
    .string()
    .min(1)
    .max(1024)
    .refine(
      (path) =>
        !path.includes('\\') &&
        !path.includes('\0') &&
        !path.startsWith('/') &&
        path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
      'bundle path must be a contained POSIX-style relative path',
    ),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  role: z.enum(['model', 'installed-manifest', 'catalog-manifest', 'catalog-file']),
});
export type GezmodelFile = z.infer<typeof GezmodelFileSchema>;

export const GezmodelLicenseSchema = z.object({
  name: z.string().min(1),
  shortName: z.string().min(1).optional(),
  class: LicenseClassSchema.optional(),
  url: z.string().url().optional(),
});
export type GezmodelLicense = z.infer<typeof GezmodelLicenseSchema>;

/** Root `manifest.json` wire format for `.gezmodel` v1. */
export const GezmodelBundleManifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('gezel-model'),
  id: z.string().regex(IdRegex),
  name: z.string().min(1).max(256),
  engine: GezmodelEngineSchema,
  createdAt: z.string().datetime(),
  createdBy: z.literal('gezel'),
  catalogVersion: z.string().optional(),
  approxSizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  license: GezmodelLicenseSchema.optional(),
  files: z.array(GezmodelFileSchema).min(2).max(16_384),
});
export type GezmodelBundleManifest = z.infer<typeof GezmodelBundleManifestSchema>;

/** Result of the mandatory scan/stage phase, shown in the import review UI. */
export const GezmodelImportReviewSchema = z.object({
  importId: z.string().uuid(),
  manifest: GezmodelBundleManifestSchema,
  alreadyInstalled: z.boolean(),
  warnings: z.array(z.string()),
});
export type GezmodelImportReview = z.infer<typeof GezmodelImportReviewSchema>;

/** Live work reported while a `.gezmodel` bundle is staged and security-checked. */
export type GezmodelImportProgress =
  | { phase: 'receiving'; bytesCompleted: number; bytesTotal?: number }
  | { phase: 'inspecting' }
  | { phase: 'verifying'; bytesCompleted: number; bytesTotal: number }
  | { phase: 'validating' };

// ─ Private → shared model migration ─────────────────────────────────────
//
// A user daemon may discover complete models in its own writable store (or
// in one of Gezel's well-known per-user homes) while a machine engine broker
// owns the canonical shared store. The source is deliberately an enum rather
// than a filesystem path: callers cannot use this API to make the daemon read
// an arbitrary directory.

export const SharedModelMigrationSourceSchema = z.enum(['current', 'default', 'development']);
export type SharedModelMigrationSource = z.infer<typeof SharedModelMigrationSourceSchema>;

export const SharedModelMigrationCandidateSchema = z.object({
  source: SharedModelMigrationSourceSchema,
  sourceLabel: z.string().min(1).max(128),
  engine: GezmodelEngineSchema,
  id: z.string().regex(IdRegex),
  name: z.string().min(1).max(256),
  approxSizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  catalogVersion: z.string().min(1),
  /** The user daemon is currently copying and verifying this candidate. */
  moving: z.boolean().default(false),
});
export type SharedModelMigrationCandidate = z.infer<typeof SharedModelMigrationCandidateSchema>;

export const SharedModelMigrationCandidatesResponseSchema = z.object({
  available: z.boolean(),
  candidates: z.array(SharedModelMigrationCandidateSchema),
});
export type SharedModelMigrationCandidatesResponse = z.infer<
  typeof SharedModelMigrationCandidatesResponseSchema
>;

export const SharedModelMigrationRequestSchema = z.object({
  source: SharedModelMigrationSourceSchema,
  engine: GezmodelEngineSchema,
  id: z.string().regex(IdRegex),
});
export type SharedModelMigrationRequest = z.infer<typeof SharedModelMigrationRequestSchema>;

export const SharedModelMigrationResultSchema = z.object({
  ok: z.literal(true),
  engine: GezmodelEngineSchema,
  id: z.string().regex(IdRegex),
  localRemoved: z.boolean(),
  warning: z.string().min(1).optional(),
});
export type SharedModelMigrationResult = z.infer<typeof SharedModelMigrationResultSchema>;

// ─ Semver helpers ───────────────────────────────────────────────────
//
// Tiny inline comparator. We don't need full semver-tools — just the
// two operations the catalog uses: parse-and-compare, and pick-the-max
// from a list.

export function isSemver(v: string): boolean {
  return SemverRegex.test(v);
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifier (`rc.1` etc.); empty string means none. */
  pre: string;
}

function parseSemver(v: string): ParsedSemver | null {
  const m = SemverRegex.exec(v);
  if (!m) return null;
  // Strip build metadata (`+...`) — semver spec says it doesn't affect ordering.
  const noBuild = v.split('+', 1)[0] ?? v;
  const [versionCore, pre] = noBuild.split('-', 2) as [string, string | undefined];
  const [major, minor, patch] = versionCore.split('.').map((n) => Number.parseInt(n, 10));
  return { major: major ?? 0, minor: minor ?? 0, patch: patch ?? 0, pre: pre ?? '' };
}

function compareIdentifier(a: string, b: string): number {
  // Numeric identifiers compare numerically; alphanumerics lexically;
  // numeric identifiers always sort below alphanumerics. (semver §11.4.3)
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Number.parseInt(a, 10) - Number.parseInt(b, 10);
  if (aNum) return -1;
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Standard semver compare: returns < 0 if a < b, 0 if equal, > 0 if
 * a > b. Throws on non-semver input. Pre-release versions sort below
 * their associated normal version (1.0.0-rc.1 < 1.0.0).
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa) throw new Error(`not semver: ${a}`);
  if (!pb) throw new Error(`not semver: ${b}`);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.pre === pb.pre) return 0;
  // A version without a pre-release outranks one with a pre-release.
  if (pa.pre === '') return 1;
  if (pb.pre === '') return -1;
  const aIds = pa.pre.split('.');
  const bIds = pb.pre.split('.');
  const len = Math.max(aIds.length, bIds.length);
  for (let i = 0; i < len; i++) {
    const ai = aIds[i];
    const bi = bIds[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const c = compareIdentifier(ai, bi);
    if (c !== 0) return c;
  }
  return 0;
}
