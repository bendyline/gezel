import type { ConnectorTypeManifest } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import type { Store } from '../../fs/store.js';
import { parseScriptMeta } from '../../scripts/meta.js';
import type { RunScriptOptions, ScriptRunner } from '../../scripts/runner.js';
import type { SecretStore } from '../../secrets/types.js';
import { ScriptConnectorAdapter } from './script.js';

const TYPE: ConnectorTypeManifest = {
  schemaVersion: 1,
  kind: 'connector-type',
  id: 'github-issues',
  name: 'GitHub Issues',
  description: 'fixture',
  tags: [],
  maintainer: { name: 'Gezel' },
  version: '1.0.0',
  releasedAt: '2026-07-13T00:00:00Z',
  driver: 'script',
  source: {
    inlineFetch: [
      "import { defineScript, gezel } from '@bendyline/gezel-sdk';",
      'export const meta = defineScript({',
      "  name: 'github-issues-fetch',",
      "  description: 'Fetches GitHub issues for a connector binding.',",
      '  inputs: {',
      "    cursor: { type: 'json', description: 'Prior cursor.' },",
      "    config: { type: 'json', description: 'Connector config.' },",
      '  },',
      '  outputs: {',
      "    records: { type: 'array', description: 'Fetched issues.', itemType: 'object' },",
      "    cursor: { type: 'string', description: 'Next cursor.', nullable: true },",
      '  },',
      "  requires: ['network', 'credential:$credential'],",
      '} as const);',
      "await gezel.http.authed('https://api.github.test/issues', {",
      "  credential: '$credential',",
      '});',
      'gezel.output({ records: [], cursor: null });',
    ].join('\n'),
    idPath: '$.id',
  },
  normalize: {
    kind: 'mapping',
    map: { id: '$.id', title: '$.title', body: '$.body' },
  },
  actions: [],
  availableVersions: ['1.0.0'],
};

describe('ScriptConnectorAdapter', () => {
  it('expands a binding credential name before ScriptRunner parses inline source', async () => {
    const calls: RunScriptOptions[] = [];
    const runner = {
      run: async (opts: RunScriptOptions) => {
        calls.push(opts);
        return {
          status: 'ok',
          output: {
            records: [{ id: 7, title: 'Seven', body: 'Issue body' }],
            cursor: '2026-07-13T12:00:00Z',
          },
        } as Awaited<ReturnType<ScriptRunner['run']>>;
      },
    } as ScriptRunner;
    const adapter = new ScriptConnectorAdapter(
      TYPE,
      {
        id: 'github-issues:deadbeef',
        type: 'github-issues',
        config: { owner: 'octocat', repository: 'Hello-World' },
      },
      {
        projectId: 'alpha',
        scriptRunner: runner,
        store: {} as Store,
        secrets: {} as SecretStore,
      },
    );

    const batch = await adapter.listChangesSince('', 'prior');

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.inputs).toEqual({
      cursor: 'prior',
      config: { owner: 'octocat', repository: 'Hello-World' },
    });
    expect(call.inlineSource).not.toContain('$credential');
    const credential = 'connector-github-issues.github-issues:deadbeef';
    expect(call.inlineSource).toContain(`credential:${credential}`);
    expect(call.inlineSource).toContain(`credential: '${credential}'`);
    expect(
      parseScriptMeta(call.inlineSource!, '<connector>/github-issues-fetch.ts').requires,
    ).toEqual(['network', `credential:${credential}`]);
    expect(batch.cursor).toBe('2026-07-13T12:00:00Z');
    expect(batch.records).toEqual([
      {
        id: '7',
        raw: { id: 7, title: 'Seven', body: 'Issue body' },
      },
    ]);
    // A clean batch carries no throttle/continuation flags.
    expect(batch.rateLimited).toBeUndefined();
    expect(batch.partial).toBeUndefined();
  });

  it('passes rateLimited/partial from the script output through to the batch', async () => {
    const runner = {
      run: async () =>
        ({
          status: 'ok',
          output: {
            records: [],
            cursor: 'kept-clean-cursor',
            rateLimited: true,
            partial: true,
          },
        }) as Awaited<ReturnType<ScriptRunner['run']>>,
    } as unknown as ScriptRunner;
    const adapter = new ScriptConnectorAdapter(
      TYPE,
      { id: 'github-issues:deadbeef', type: 'github-issues', config: {} },
      {
        projectId: 'alpha',
        scriptRunner: runner,
        store: {} as Store,
        secrets: {} as SecretStore,
      },
    );

    const batch = await adapter.listChangesSince('', 'prior');
    expect(batch).toEqual({
      records: [],
      cursor: 'kept-clean-cursor',
      rateLimited: true,
      partial: true,
    });
  });

  it('ignores non-boolean throttle flags from script output', async () => {
    const runner = {
      run: async () =>
        ({
          status: 'ok',
          output: { records: [], cursor: null, rateLimited: 'yes', partial: 1 },
        }) as Awaited<ReturnType<ScriptRunner['run']>>,
    } as unknown as ScriptRunner;
    const adapter = new ScriptConnectorAdapter(
      TYPE,
      { id: 'github-issues:deadbeef', type: 'github-issues', config: {} },
      {
        projectId: 'alpha',
        scriptRunner: runner,
        store: {} as Store,
        secrets: {} as SecretStore,
      },
    );

    const batch = await adapter.listChangesSince('', null);
    expect(batch.rateLimited).toBeUndefined();
    expect(batch.partial).toBeUndefined();
  });
});
