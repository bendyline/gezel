import { z } from 'zod';
import { IdRegex } from './catalog-id.js';
import { SemverRegex } from './catalog-semver.js';

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

/**
 * The root `gezapp.json` of an AI App *source folder* — the authoring form
 * of a `.gezapp`. Deliberately minimal: everything heavy on the packed
 * manifest (`items` + per-item sha256, `createdAt`, `dependencies`,
 * `minGezelVersion`, `signature`) is derived from the `items/` tree by
 * `gezel app pack`, never hand-maintained. Strict so an author who pastes
 * packed-manifest fields here gets told they are generated, not silently
 * carried stale.
 */
export const GezappSourceManifestSchema = z
  .object({
    format: z.literal('gezel-ai-app-source'),
    schemaVersion: z.literal(1),
    /**
     * Optional entry pin. When the items tree holds exactly one project
     * type, both fields are discovered; `version` defaults to the highest
     * semver version folder present.
     */
    entry: z
      .object({
        projectType: z.string().regex(IdRegex).optional(),
        version: z.string().regex(SemverRegex).optional(),
      })
      .optional(),
    /** Defaults to the entry project type identity's maintainer at pack time. */
    publisher: z
      .object({
        name: z.string().min(1),
        url: z.string().url().optional(),
      })
      .optional(),
  })
  .strict();
export type GezappSourceManifest = z.infer<typeof GezappSourceManifestSchema>;

/** The source-folder manifest filename beside `items/`. */
export const GEZAPP_SOURCE_MANIFEST_FILENAME = 'gezapp.json';
