import { z } from 'zod';

/**
 * A connection whose data stays on models that run on this computer
 * (`connectionKeepsLocal`). Stamped on a session that was shown the data, so
 * the conversation stays here too, and on what such a session wrote.
 */
export const KeptLocalSourceSchema = z.object({
  /** The project the connection is in, which need not be the session's. */
  projectId: z.string(),
  bindingId: z.string(),
  /** What the person calls the connection, for messages about it. */
  name: z.string(),
});
export type KeptLocalSource = z.infer<typeof KeptLocalSourceSchema>;

/** An artifact that holds kept-local data outside a connection's own folder. */
export const KeptLocalEntrySchema = z.object({
  /** A file or folder, relative to the project's artifacts. */
  path: z.string(),
  source: KeptLocalSourceSchema,
});
export type KeptLocalEntry = z.infer<typeof KeptLocalEntrySchema>;

/**
 * `projects/{id}/kept-local.json`: the folders removed connections left
 * behind, and the files and task folders written by conversations that read
 * kept-local data.
 */
export const KeptLocalLedgerSchema = z.object({
  version: z.literal(1),
  entries: z.array(KeptLocalEntrySchema),
});
export type KeptLocalLedger = z.infer<typeof KeptLocalLedgerSchema>;
