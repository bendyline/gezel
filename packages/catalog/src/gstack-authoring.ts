import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { gildePackageRoot } from './gilde-data.js';

/** Repository-relative home of the reproducible gstack authoring inputs. */
export const GSTACK_AUTHORING_RELATIVE_DIR = join('authoring', 'gstack');

export function gstackAuthoringDir(gildeRoot: string): string {
  return join(gildeRoot, GSTACK_AUTHORING_RELATIVE_DIR);
}

export const GstackWaveBookSchema = z
  .object({
    source: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().min(1),
    description: z.string().min(1),
    tags: z.array(z.string().min(1)),
  })
  .strict();

export const GstackWaveConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    releasedAt: z.string().datetime(),
    sourceRevision: z.string().regex(/^[0-9a-f]{40}$/),
    basedOn: z
      .object({
        name: z.string().min(1),
        url: z.string().url(),
      })
      .strict(),
    books: z.array(GstackWaveBookSchema).min(1),
  })
  .strict()
  .superRefine((wave, ctx) => {
    for (const field of ['source', 'id'] as const) {
      const seen = new Set<string>();
      wave.books.forEach((book, index) => {
        if (seen.has(book[field])) {
          ctx.addIssue({
            code: 'custom',
            path: ['books', index, field],
            message: `duplicate ${field} "${book[field]}"`,
          });
        }
        seen.add(book[field]);
      });
    }
  });

export type GstackWaveBook = z.infer<typeof GstackWaveBookSchema>;
export type GstackWaveConfig = z.infer<typeof GstackWaveConfigSchema>;

export function readGstackWaveConfig(gildeRoot: string): GstackWaveConfig {
  const path = join(gstackAuthoringDir(gildeRoot), 'wave.json');
  return GstackWaveConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

/**
 * Resolve the Gilde root that owns both the gstack authoring inputs and their
 * generated catalog payloads.
 *
 * Local content work can opt into a checkout with GILDE_DIR. Otherwise the
 * exact installed (or `pnpm link:gilde`-linked) @bendyline/gilde package owns
 * both sides of the regeneration-fidelity comparison. We deliberately do not
 * auto-discover a sibling checkout: that would mask a stale registry pin in CI.
 */
export function findGstackAuthoringGildeRoot(): string | undefined {
  const override = process.env.GILDE_DIR?.trim();
  if (override) {
    const root = resolve(override);
    if (existsSync(gstackAuthoringDir(root))) return root;
    throw new Error(
      `[gstack] GILDE_DIR does not contain ${GSTACK_AUTHORING_RELATIVE_DIR}: ${root}`,
    );
  }

  const installedRoot = gildePackageRoot();
  if (existsSync(gstackAuthoringDir(installedRoot))) return installedRoot;

  return undefined;
}

export function resolveGstackAuthoringGildeRoot(): string {
  const root = findGstackAuthoringGildeRoot();
  if (root) return root;

  throw new Error(
    `[gstack] authoring inputs not found. Set GILDE_DIR, run pnpm link:gilde, or install a @bendyline/gilde release containing ${GSTACK_AUTHORING_RELATIVE_DIR}.`,
  );
}
