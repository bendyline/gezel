import type { ConnectorTypeManifest } from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerGitHubPullsAdapters } from './natives/github-pulls.js';
import { registerProductConnectorAdapters } from './product-wiring.js';
import { NATIVE_ADAPTERS } from './registry.js';

/**
 * The connector catalog (gilde content, pinned) and this build's code must
 * agree. Gezel and gilde ship separately, so drift is the normal failure mode:
 * a manifest naming a native adapter this build never registers binds fine
 * and then fails every sync with "no native connector adapter registered" — a
 * day later, in someone's lastError. These checks move that to CI.
 *
 * The reverse direction is deliberately not checked: code may run ahead of
 * the content (an adapter registered before its manifest ships), which is how
 * every new connector type lands.
 */

let manifests: ConnectorTypeManifest[] = [];

beforeAll(async () => {
  registerProductConnectorAdapters();
  // github-pulls needs the PR service, so service boot registers it from
  // wireProductConnectorTaskPreparation; the factory is never invoked here.
  registerGitHubPullsAdapters({
    prs: {} as never,
    project: async () => {
      throw new Error('not used');
    },
    currentBranch: async () => undefined,
  });
  const catalog = new CatalogService();
  const items = await catalog.list('connector-type');
  for (const item of items) {
    const detail = await catalog.get('connector-type', item.manifest.id);
    if (detail?.manifest.kind === 'connector-type') manifests.push(detail.manifest);
  }
  manifests = manifests.sort((a, b) => a.id.localeCompare(b.id));
});

describe('connector catalog ↔ adapter registry', () => {
  it('the pinned catalog ships connector types', () => {
    expect(manifests.length).toBeGreaterThan(0);
  });

  it('every native connector type names an adapter this build registers', () => {
    const missing = manifests
      .filter((m) => m.driver === 'native')
      .map((m) => ({
        id: m.id,
        adapterId: String((m.source as { adapterId?: unknown }).adapterId ?? ''),
      }))
      .filter((m) => !NATIVE_ADAPTERS.has(m.adapterId));
    expect(missing).toEqual([]);
  });

  it('every connector type states its completeness', () => {
    expect(manifests.filter((m) => !m.completeness).map((m) => m.id)).toEqual([]);
  });

  it('every OAuth type is linkable with a bring-your-own app', () => {
    const problems: string[] = [];
    for (const m of manifests) {
      const shape = (m.secretShape ?? {}) as Record<string, unknown>;
      if (shape.kind !== 'oauth2') continue;
      for (const key of ['authorizeUrl', 'tokenUrl']) {
        const url = shape[key];
        if (typeof url !== 'string' || !url.startsWith('https://')) {
          problems.push(`${m.id}: ${key} must be an https URL`);
        }
      }
      if (typeof shape.clientIdEnv !== 'string' || !/^GEZEL_[A-Z0-9_]+$/.test(shape.clientIdEnv)) {
        problems.push(`${m.id}: clientIdEnv must be a GEZEL_* name`);
      }
      const setup = shape.clientSetup as
        | { providerLabel?: unknown; docsUrl?: unknown; steps?: unknown }
        | undefined;
      if (!setup?.providerLabel || typeof setup.docsUrl !== 'string') {
        problems.push(`${m.id}: clientSetup needs providerLabel and docsUrl`);
      }
      if (!Array.isArray(setup?.steps) || setup.steps.length === 0) {
        problems.push(`${m.id}: clientSetup.steps tells a person how to register the app`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('types sharing one OAuth client env name agree on the provider', () => {
    const byEnv = new Map<string, Set<string>>();
    for (const m of manifests) {
      const shape = (m.secretShape ?? {}) as {
        kind?: unknown;
        clientIdEnv?: unknown;
        tokenUrl?: unknown;
      };
      if (shape.kind !== 'oauth2' || typeof shape.clientIdEnv !== 'string') continue;
      const origin = typeof shape.tokenUrl === 'string' ? new URL(shape.tokenUrl).origin : '';
      byEnv.set(shape.clientIdEnv, (byEnv.get(shape.clientIdEnv) ?? new Set()).add(origin));
    }
    // One registered app per provider serves every type naming its env pair,
    // so two providers behind one name would hand Google's client id to Microsoft.
    const conflicts = [...byEnv].filter(([, origins]) => origins.size > 1).map(([env]) => env);
    expect(conflicts).toEqual([]);
  });

  it('every declared action names a consent scope', () => {
    const missing = manifests.flatMap((m) =>
      m.actions.filter((a) => !a.consentScope).map((a) => `${m.id}.${a.name}`),
    );
    expect(missing).toEqual([]);
  });
});
