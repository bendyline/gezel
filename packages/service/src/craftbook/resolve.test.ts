import type { CraftbookTemplateManifest } from '@bendyline/gezel';
import { CraftbookSchema, CraftbookTemplateManifestSchema } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { runtimeCraftbookFromTemplate } from './resolve.js';

/**
 * A manifest with every carryable field populated. The point is coverage of
 * the mapping surface, not realism — each value only has to be distinctive
 * enough to prove it survived.
 */
const FULL: CraftbookTemplateManifest = CraftbookTemplateManifestSchema.parse({
  schemaVersion: 1,
  kind: 'craftbook-template',
  id: 'everything',
  name: 'Everything',
  description: 'Manifest description.',
  about: 'Long-form about text.',
  maintainer: { name: 'Gezel' },
  version: '1.0.0',
  releasedAt: '2026-08-15T00:00:00Z',
  entryStepId: 'first',
  steps: [{ id: 'first', name: 'First', prompt: 'Do the thing.', terminal: true }],
  basedOn: { name: 'Source', url: 'https://example.invalid/source' },
  plan: 'A plan.',
  defaultAssignee: { kind: 'gezel', gezelId: 'ayza' },
  triggers: ['do everything'],
  hooks: [{ phase: 'PreToolUse', decision: 'allow' }],
  toolsets: [{ toolsetId: 'github', optional: true }],
  connectors: [{ typeId: 'github-pulls', reason: 'mirror the pull request' }],
  paramSchema: { type: 'object', properties: { focus: { type: 'string' } } },
  command: 'everything',
  requirements: [{ kind: 'github' }],
  runModes: { scheduled: 'supported' },
  spawn: {
    overFile: 'items.json',
    steps: [{ id: 'child', name: 'Child', prompt: 'Child work.', terminal: true }],
  },
});

/**
 * Fields the mapper is expected to carry, derived from the two schemas
 * rather than hand-listed: anything a template manifest and a runtime
 * craftbook both declare has to survive the hop.
 */
function sharedFields(): string[] {
  const manifest = new Set(Object.keys(CraftbookTemplateManifestSchema.shape));
  return Object.keys(CraftbookSchema.shape).filter((key) => manifest.has(key));
}

describe('runtimeCraftbookFromTemplate', () => {
  it('carries every field the runtime craftbook shape shares with the manifest', () => {
    // The mapper's whole promise is that a field added to the template
    // schema cannot ride into one snapshot and silently miss another. It
    // was broken once (`connectors`), which disabled launch-time connector
    // prep for every catalog craftbook without a single error.
    const book = runtimeCraftbookFromTemplate(FULL, FULL.about, { 'gate.ts': 'export {}' });
    const missing = sharedFields().filter((key) => book[key as keyof typeof book] === undefined);
    expect(missing).toEqual([]);
  });

  it('carries connector needs so launch-time prep runs', () => {
    const book = runtimeCraftbookFromTemplate(FULL, undefined, undefined);
    expect(book.connectors).toEqual([
      { typeId: 'github-pulls', reason: 'mirror the pull request' },
    ]);
  });

  it('prefers the about text over the manifest description', () => {
    expect(runtimeCraftbookFromTemplate(FULL, 'About wins.', undefined).description).toBe(
      'About wins.',
    );
    expect(runtimeCraftbookFromTemplate(FULL, undefined, undefined).description).toBe(
      'Manifest description.',
    );
  });

  it('omits absent optional fields rather than writing undefined', () => {
    const minimal = CraftbookTemplateManifestSchema.parse({
      schemaVersion: 1,
      kind: 'craftbook-template',
      id: 'minimal',
      name: 'Minimal',
      description: 'Nothing optional.',
      about: '',
      maintainer: { name: 'Gezel' },
      version: '1.0.0',
      releasedAt: '2026-08-15T00:00:00Z',
      entryStepId: 'only',
      steps: [{ id: 'only', name: 'Only', prompt: 'Work.', terminal: true }],
    });
    const book = runtimeCraftbookFromTemplate(minimal, undefined, undefined);
    expect('connectors' in book).toBe(false);
    expect(CraftbookSchema.parse(book).id).toBe('minimal');
  });
});
