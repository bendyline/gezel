import { randomUUID } from 'node:crypto';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { readSystemServiceRuntime, systemServiceHome } from './system-service.js';

export const REQUIRED_MACHINE_ENGINE_CAPABILITY = 'native-capacity-v1' as const;

export interface MachineEngineCompatibilityIssue {
  source: 'machine-engine';
  capability: typeof REQUIRED_MACHINE_ENGINE_CAPABILITY;
  serviceHome: string;
  installedVersion: string | null;
}

interface InspectMachineEngineCompatibilityOptions {
  logger?: { info?: (message: string) => void; warn?: (message: string) => void };
}

/**
 * Probe the exact machine-broker capability an isolated local engine needs.
 *
 * Development services intentionally do not adopt the installed broker for
 * inference, but they still coordinate memory reservations with it. Older
 * retail brokers predate that coordination endpoint, and deferring the check
 * until the first model launch turns an installation mismatch into a failed
 * chat turn. A random `status` lookup is side-effect-free and works as a
 * capability handshake without relying on version comparison (workspace
 * builds commonly identify themselves as 0.0.0).
 */
export async function inspectMachineEngineCompatibility(
  options: InspectMachineEngineCompatibilityOptions = {},
): Promise<MachineEngineCompatibilityIssue | null> {
  const serviceHome = systemServiceHome();
  if (!serviceHome) return null;

  const runtime = await readSystemServiceRuntime(serviceHome).catch((error) => {
    options.logger?.info?.(
      `[supervisor] machine-engine compatibility preflight skipped: ${errorMessage(error)}`,
    );
    return null;
  });
  if (runtime?.serviceRole !== 'machine-engine') return null;

  const managedFetch = runtime.cert ? createTrustingFetch({ cert: runtime.cert }) : null;
  const fetchImpl = managedFetch ?? fetch;
  try {
    const response = await fetchImpl(`${runtime.baseUrl}/v1/remote/manage/native-capacity`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${runtime.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ action: 'status', id: randomUUID() }),
      signal: AbortSignal.timeout(5_000),
    });
    try {
      if (response.status !== 404) return null;
    } finally {
      await response.body?.cancel().catch(() => undefined);
    }

    let installedVersion: string | null = null;
    try {
      const health = await fetchImpl(`${runtime.baseUrl}/api/health`, {
        headers: { authorization: `Bearer ${runtime.token}` },
        signal: AbortSignal.timeout(5_000),
      });
      try {
        if (health.ok) {
          const body = (await health.json()) as { version?: unknown };
          if (typeof body.version === 'string' && body.version.trim() !== '') {
            installedVersion = body.version;
          }
        }
      } finally {
        await health.body?.cancel().catch(() => undefined);
      }
    } catch (error) {
      options.logger?.info?.(
        `[supervisor] installed machine-engine version probe failed: ${errorMessage(error)}`,
      );
    }

    return {
      source: 'machine-engine',
      capability: REQUIRED_MACHINE_ENGINE_CAPABILITY,
      serviceHome,
      installedVersion,
    };
  } catch (error) {
    // Unavailable/rotating runtime metadata is handled by the ordinary broker
    // recovery path. Only a definitive 404 means "installed but too old".
    options.logger?.info?.(
      `[supervisor] machine-engine compatibility preflight inconclusive: ${errorMessage(error)}`,
    );
    return null;
  } finally {
    await managedFetch?.close().catch(() => undefined);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
