import { describe, expect, it } from 'vitest';
import { inspectVSCodeConfig, removeGezelProvider, upsertGezelProvider } from './profile-config.js';

const gezel = {
  name: 'Gezel',
  vendor: 'customendpoint',
  apiKey: 'secret',
  apiType: 'chat-completions',
  models: [{ id: 'gezel:maya', name: 'Maya', url: 'http://127.0.0.1:22222/v1/chat/completions' }],
};

describe('VS Code profile config merge', () => {
  it('adds Gezel without rewriting another provider or its JSONC comments', () => {
    const original = `[
  // This belongs to the user.
  { "name": "Work endpoint", "vendor": "customendpoint", "apiKey": "other", },
]\n`;

    const merged = upsertGezelProvider(original, gezel);

    expect(merged).toContain('// This belongs to the user.');
    expect(merged).toContain(
      '{ "name": "Work endpoint", "vendor": "customendpoint", "apiKey": "other", }',
    );
    const inspected = inspectVSCodeConfig(merged);
    expect(inspected.providers).toHaveLength(2);
    expect(inspected.gezelProvider).toMatchObject({ apiKey: 'secret' });
  });

  it('replaces and removes only the Gezel entry', () => {
    const original = upsertGezelProvider(
      '[{"name":"Other","vendor":"customendpoint","apiKey":"keep"}]\n',
      gezel,
    );
    const updated = upsertGezelProvider(
      original,
      { ...gezel, apiKey: 'rotated' },
      { replaceConflict: true },
    );

    expect(inspectVSCodeConfig(updated).gezelProvider).toMatchObject({ apiKey: 'rotated' });
    const removed = removeGezelProvider(updated);
    expect(inspectVSCodeConfig(removed).providers).toEqual([
      { name: 'Other', vendor: 'customendpoint', apiKey: 'keep' },
    ]);
    expect(removed).toContain('"keep"');
  });

  it('inserts before trailing comments without turning the separator into a comment', () => {
    const original = `[
  {"name":"Other","vendor":"customendpoint","apiKey":"keep"}
  // Keep this note at the end of the profile.
]\n`;

    const merged = upsertGezelProvider(original, gezel);

    expect(merged).toContain('// Keep this note at the end of the profile.');
    expect(inspectVSCodeConfig(merged).providers).toHaveLength(2);
  });

  it('refuses malformed files and duplicate Gezel entries', () => {
    expect(() => inspectVSCodeConfig('{"not":"an array"}')).toThrow(/provider array/);
    const duplicate = JSON.stringify([
      { name: 'Other', vendor: 'customendpoint', apiKey: 'keep' },
      gezel,
      gezel,
    ]);
    expect(() => upsertGezelProvider(duplicate, gezel)).toThrow(/more than one Gezel/);
    const repaired = inspectVSCodeConfig(
      upsertGezelProvider(duplicate, { ...gezel, apiKey: 'repaired' }, { replaceConflict: true }),
    );
    expect(repaired.providers).toHaveLength(2);
    expect(repaired.providers[0]).toMatchObject({ name: 'Other', apiKey: 'keep' });
    expect(repaired.gezelProvider).toMatchObject({ apiKey: 'repaired' });
  });
});
