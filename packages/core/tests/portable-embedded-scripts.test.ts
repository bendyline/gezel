import { describe, expect, it } from 'vitest';
import { portableScriptSourceHash } from '../src/runtime/script-sources.js';
import { portableFixture } from '../src/runtime/test-files.js';
import { CraftbookSchema } from '../src/schemas/craftbook.js';

const source = `import {defineScript, gezel} from '@bendyline/gezel-sdk'; export const meta = defineScript({name:'prepare',description:'Prepare an offline artifact',requires:['artifacts.write']}); const literal='{{task.dir}}'; await gezel.artifacts.write('result.md',literal); gezel.output({ok:true});`;
function book(version = '1.2.3', body = source) {
  return CraftbookSchema.parse({
    id: 'embedded-workflow',
    version,
    name: 'Embedded workflow',
    scripts: { prepare: body },
    entryStepId: 'work',
    steps: [
      {
        id: 'work',
        name: 'Work',
        terminal: true,
        onEnter: { name: 'prepare', scope: 'craftbook', autoAdvanceOnSuccess: true },
      },
    ],
    createdAt: '2026-09-20T00:00:00Z',
    updatedAt: '2026-09-20T00:00:00Z',
  });
}
const input = {
  title: 'Snapshot work',
  description: 'Execute the exact embedded source that belonged to this task at creation.',
  craftbookId: 'embedded-workflow',
};
describe('embedded craftbook source persistence', () => {
  it('snapshots exact source bytes and template version, while installing ordinary provenance-marked project copies', async () => {
    const { store } = portableFixture();
    await store.ensureLayout();
    const first = await store.createTask('default', input, book());
    expect(first.craftbook.scripts?.prepare).toBe(source);
    expect(first.sourceCraftbookIds[0]).toMatchObject({
      catalogId: 'embedded-workflow',
      version: '1.2.3',
    });
    const installed = await store.readScriptSource(
      { scope: 'project', projectId: 'default' },
      'prepare',
    );
    expect(installed?.source).toBe(`// @gezel-craftbook: embedded-workflow@1.2.3\n${source}`);
    expect(installed?.provenance).toEqual({ kind: 'craftbook', ref: 'embedded-workflow@1.2.3' });
    const updated = source.replace('result.md', 'new-result.md');
    await store.createTask('default', input, book('2.0.0', updated));
    expect((await store.getTask(first.ref))?.craftbook.scripts?.prepare).toBe(source);
    expect(
      (await store.readScriptSource({ scope: 'project', projectId: 'default' }, 'prepare'))?.source,
    ).toContain('embedded-workflow@2.0.0');
  });
  it('preserves unrelated authored project scripts and round-trips scope/source identity in run audits', async () => {
    const { store } = portableFixture();
    await store.ensureLayout();
    await store.saveScriptSource(
      { scope: 'project', projectId: 'default' },
      { name: 'prepare', source: 'User-authored work' },
    );
    const task = await store.createTask('default', input, book());
    expect(
      (await store.readScriptSource({ scope: 'project', projectId: 'default' }, 'prepare'))?.source,
    ).toBe('User-authored work');
    expect(task.craftbook.scripts?.prepare).toBe(source);
    const sourceHash = await portableScriptSourceHash(source);
    const run = {
      id: crypto.randomUUID(),
      projectId: 'default',
      scriptName: 'prepare',
      scope: 'craftbook' as const,
      sourceHash,
      sourceCraftbook: { id: task.craftbook.id, version: task.craftbook.version },
      startedAt: '2026-09-20T00:00:00Z',
      status: 'ok' as const,
      trigger: {
        kind: 'step' as const,
        taskRef: task.ref,
        stepId: 'work',
        moment: 'enter' as const,
      },
      inputs: {},
      calls: [],
      logs: '',
    };
    await store.writeScriptRun(run);
    expect(await store.getScriptRun('default', run.id)).toEqual(run);
  });
});
