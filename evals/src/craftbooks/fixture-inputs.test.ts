import { describe, expect, it } from 'vitest';
import { evalSpecFromTestSpec } from './adapter.ts';
import { evalFixtureInputs } from './fixture-inputs.ts';
import { loadCraftbookTestSpecsSync } from './test-spec-loader.ts';

const loaded = loadCraftbookTestSpecsSync().find((spec) => spec.craftbookId === 'codemod-sweep')!;

describe('pinned fixture input correction', () => {
  it('keeps the unchanged helper seeded and graded without requiring it to be opened', () => {
    const original = structuredClone(loaded);
    const adapted = evalSpecFromTestSpec(loaded);
    const helper = adapted.setup?.files?.find((file) => file.path === 'src/log.js');
    expect(helper?.modelInput).toBe(false);
    expect(helper?.content).toBe(
      loaded.spec.setup.files?.find((file) => file.path === 'src/log.js')?.content,
    );
    expect(adapted.success.unchangedFixtures).toContain('src/log.js');
    expect(adapted.success.checks).toEqual(loaded.spec.success.checks);
    expect(adapted.setup?.files?.filter((file) => file.path !== 'src/log.js')).toEqual(
      loaded.spec.setup.files?.filter((file) => file.path !== 'src/log.js'),
    );
    expect(loaded).toEqual(original);
  });

  it.each(['version', 'book', 'content', 'explicit-input', 'invariant', 'surface'])(
    'does not exempt a fixture when its %s contract changes',
    (change) => {
      const changed = structuredClone(loaded);
      const helper = changed.spec.setup.files!.find((file) => file.path === 'src/log.js')!;
      if (change === 'version') changed.version = '1.0.5';
      if (change === 'book') changed.craftbookId = 'another-book';
      if (change === 'content') helper.content += '\n// fetchUserData\n';
      if (change === 'explicit-input') helper.modelInput = true;
      if (change === 'invariant') changed.spec.success.unchangedFixtures = [];
      if (change === 'surface') helper.surface = 'artifact';
      expect(evalFixtureInputs(changed)).toEqual(changed.spec.setup.files);
    },
  );
});
