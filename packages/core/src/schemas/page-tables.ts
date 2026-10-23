import { z } from 'zod';
import { ObservationColumnSchema } from './observations.js';

/** Page queries use host-issued table names; callers never choose project paths. */
export const PageTableRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list') }).strict(),
  z.object({ op: z.literal('describe'), table: z.string().min(1).max(200) }).strict(),
  z
    .object({
      op: z.literal('query'),
      sql: z.string().min(1).max(20_000),
      tables: z.array(z.string().min(1).max(200)).min(1).max(64).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    })
    .strict(),
]);
export type PageTableRequest = z.infer<typeof PageTableRequestSchema>;

export const PageTableInfoSchema = z.object({
  name: z.string(),
  title: z.string(),
  source: z.enum(['workspace', 'artifacts']),
  path: z.string(),
  rows: z.number().nonnegative(),
  columnCount: z.number().int().nonnegative(),
  updatedAt: z.string().optional(),
  schemaInferred: z.boolean(),
});
export type PageTableInfo = z.infer<typeof PageTableInfoSchema>;

export const PageTableResponseSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('list'), tables: z.array(PageTableInfoSchema) }),
  z.object({
    op: z.literal('describe'),
    table: PageTableInfoSchema,
    columns: z.array(ObservationColumnSchema),
    description: z.string().optional(),
    grain: z.string().optional(),
  }),
  z.object({
    op: z.literal('query'),
    rows: z.array(z.record(z.string(), z.unknown())),
    columns: z.array(z.string()),
    truncated: z.boolean(),
    limit: z.number(),
    tablesInScope: z.array(z.string()),
  }),
]);
export type PageTableResponse = z.infer<typeof PageTableResponseSchema>;
