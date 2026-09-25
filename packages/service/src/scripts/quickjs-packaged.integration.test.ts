import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { QuickJSWorkerExecutor as ExecutorType } from './quickjs-executor.js';

const bundle = new URL('../../dist/index.js', import.meta.url);
const worker = new URL('../../dist/scripts/quickjs-worker.js', import.meta.url);

describe('packaged QuickJS worker', () => {
  it.skipIf(!existsSync(bundle) || !existsSync(worker))(
    'runs through the public service bundle and its emitted worker',
    async () => {
      // A variable URL loads the emitted production entry rather than importing
      // the source adapter through Vitest. This caught a host-heap limit that
      // passed raw-source execution but could not load the packaged worker.
      const service = (await import(bundle.href)) as {
        QuickJSWorkerExecutor: new () => ExecutorType;
      };
      const notifications: unknown[] = [];
      const result = await new service.QuickJSWorkerExecutor().execute({
        source: `import { gezel } from '@bendyline/gezel-sdk';
          const body: string = await gezel.artifacts.read('fixture.txt');
          gezel.output({ body });`,
        scriptName: 'packaged-smoke',
        init: {
          input: {},
          runId: 'packaged-smoke',
          projectId: 'fixture',
          engagementMode: 'off',
          engagementFlags: { llmAllowed: false },
        },
        timeoutMs: 5_000,
        provenanceTrusted: false,
        trustedReadOnlyStandard: false,
        onRequest: async (method, params) => {
          expect(method).toBe('artifact.read');
          expect(params).toEqual({ path: 'fixture.txt' });
          return 'packaged worker roundtrip';
        },
        onNotification: (method, params) => notifications.push({ method, params }),
        onStdout: () => {},
        onStderr: () => {},
      });
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
      expect(notifications).toEqual([
        { method: 'script.output', params: { value: { body: 'packaged worker roundtrip' } } },
      ]);
    },
  );
});
