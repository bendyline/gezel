import { readFile } from 'node:fs/promises';
import { createLogger } from '@bendyline/gezel';
import type { SecretStore } from './types.js';

const log = createLogger('secrets');

/**
 * Test/eval seam: when `GEZEL_SEED_SECRETS_FILE` names a JSON file, seed
 * its toolset-kind secrets into the store once at boot. Lets a harness
 * (the eval mock-service rail, integration tests) provision credentials
 * like `mock.<service>` without a UI round-trip — the file shape is
 *
 *   [{ "toolsetId": "mock", "fieldId": "ci", "value": "…" }, …]
 *
 * Deliberately narrow: toolset-kind entries only (the `<toolsetId>.<fieldId>`
 * credential namespace) — provider credentials (GitHub/OpenAI/… keys)
 * cannot be seeded this way. Off unless the env var is set; a malformed
 * file warns and is ignored — boot never fails on a seed.
 */
export async function seedSecretsFromEnvFile(secrets: SecretStore): Promise<void> {
  const file = process.env.GEZEL_SEED_SECRETS_FILE?.trim();
  if (!file) return;
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    log.warn(`[seed] GEZEL_SEED_SECRETS_FILE set but unreadable (${file}):`, err);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn(`[seed] GEZEL_SEED_SECRETS_FILE is not valid JSON (${file}):`, err);
    return;
  }
  if (!Array.isArray(parsed)) {
    log.warn(`[seed] GEZEL_SEED_SECRETS_FILE must be a JSON array (${file})`);
    return;
  }
  let seeded = 0;
  for (const entry of parsed) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof (entry as { toolsetId?: unknown }).toolsetId !== 'string' ||
      typeof (entry as { fieldId?: unknown }).fieldId !== 'string' ||
      typeof (entry as { value?: unknown }).value !== 'string'
    ) {
      log.warn('[seed] skipping malformed seed entry (need toolsetId/fieldId/value strings)');
      continue;
    }
    const { toolsetId, fieldId, value } = entry as {
      toolsetId: string;
      fieldId: string;
      value: string;
    };
    try {
      await secrets.set({ kind: 'toolset', toolsetId, fieldId }, value);
      seeded++;
    } catch (err) {
      log.warn(`[seed] failed to store ${toolsetId}.${fieldId}:`, err);
    }
  }
  if (seeded > 0) log.info(`[seed] seeded ${seeded} toolset secret(s) from ${file}`);
}
