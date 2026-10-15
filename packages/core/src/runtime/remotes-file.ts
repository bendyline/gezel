import { z } from 'zod';
import type { PortableRepository } from './repository.js';

/**
 * `remotes.json`: the servers this device paired with and the identity it
 * paired as. Device tier (`storageTierFor`), so it stays in the app's own
 * storage — never the person's synced Work folder, never a gezel backup —
 * because it holds each server's device token.
 */
export const PORTABLE_REMOTES_FILE = 'remotes.json';

const KnownModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  contextWindow: z.number().optional(),
  supportsTools: z.boolean().optional(),
  supportsReasoning: z.boolean().optional(),
  parameterSize: z.string().optional(),
});

export const PortablePairedServerSchema = z.object({
  remoteId: z.string(),
  baseUrl: z.string(),
  displayName: z.string(),
  token: z.string(),
  pinnedIdentityKey: z.string(),
  pinnedIdentityFingerprint: z.string(),
  tlsCertPem: z.string(),
  scopes: z.array(z.string()),
  pairedAt: z.number(),
  lastSeenAt: z.number().optional(),
  knownModels: z.array(KnownModelSchema).max(200).optional(),
});
export type PortablePairedServer = z.infer<typeof PortablePairedServerSchema>;

export const PortableRemotesSchema = z.object({
  version: z.literal(1),
  identity: z
    .object({ deviceId: z.string(), publicKeyPem: z.string(), fingerprint: z.string() })
    .optional(),
  servers: z.array(PortablePairedServerSchema).default([]),
});
export type PortableRemotes = z.infer<typeof PortableRemotesSchema>;

export async function readRemotes(repo: PortableRepository): Promise<PortableRemotes> {
  return (
    (await repo.tolerantRecord(PORTABLE_REMOTES_FILE, PortableRemotesSchema)) ?? {
      version: 1,
      servers: [],
    }
  );
}

export async function writeRemotes(
  repo: PortableRepository,
  remotes: PortableRemotes,
): Promise<void> {
  const value = PortableRemotesSchema.parse(remotes);
  await repo.transactions.commit(new Map([[PORTABLE_REMOTES_FILE, repo.json(value)]]));
}
