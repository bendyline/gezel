import type { MobileProvider } from '@bendyline/gezel/mobile-providers';
import type { PortableCatalogModel, PortableProductService } from '@bendyline/gezel/runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ModelChooser, catalogModelFits, modelChoices, modelDisplayName } from './ModelChooser.js';
import type { MobileHost, ModelInventory } from './native.js';

const GB = 1024 ** 3;
const catalogModel = (catalogId: string, name: string, gigabytes: number) =>
  ({
    name,
    approxSizeBytes: gigabytes * GB,
    source: {
      catalogId,
      catalogVersion: '1.0.0',
      sourceId: 'bundled',
      huggingfaceRepo: 'org/repo',
      revision: 'a'.repeat(40),
      filename: `${catalogId}.gguf`,
      sha256: 'b'.repeat(64),
    },
  }) as PortableCatalogModel;

describe('which downloads a phone is offered', () => {
  it('leaves out only a model that clearly cannot fit', () => {
    const budget = 3 * GB;
    expect(catalogModelFits({ approxSizeBytes: 1.3 * GB }, budget)).toBe(true);
    expect(catalogModelFits({ approxSizeBytes: 4.2 * GB }, budget)).toBe(false);
    expect(catalogModelFits({ approxSizeBytes: 4.2 * GB }, undefined)).toBe(true);
  });

  it('names a model without its file extension', () => {
    expect(modelDisplayName('Qwen3.5-2B-Q4_K_M.gguf')).toBe('Qwen3.5-2B-Q4_K_M');
    expect(modelDisplayName('Qwen 3.5 (2B)')).toBe('Qwen 3.5 (2B)');
  });
});

describe('the model list', () => {
  const qwen = catalogModel('qwen3.5-2b-q4', 'Qwen 3.5 (2B, Q4)', 1.3);
  const minicpm = catalogModel('minicpm5-1b-q4', 'MiniCPM 5 (1B)', 0.7);
  const e4b = catalogModel('gemma4-e4b-q4', 'Gemma 4 (E4B)', 4.2);
  const inventory: ModelInventory = {
    models: [
      {
        id: 'downloaded',
        name: 'Qwen 3.5 (2B, Q4)',
        sizeBytes: 1.3 * GB,
        source: { ...qwen.source, sizeBytes: 1.3 * GB },
      },
      { id: 'sideloaded', name: 'my-model.gguf', sizeBytes: 0.5 * GB },
    ],
    selectedModelId: 'downloaded',
    memoryBudgetBytes: 3 * GB,
  };
  const providers = [
    { id: 'llama-cpp', name: 'On-device', availability: 'available' },
    { id: 'apple-foundation-models', name: 'Apple Intelligence', availability: 'unavailable' },
    { id: 'android-mlkit', name: 'Android system AI', availability: 'download-required' },
  ] as unknown as MobileProvider[];
  const { groups } = modelChoices({
    providers,
    selectedProviderId: 'llama-cpp',
    inventory,
    catalog: [minicpm, qwen, e4b],
    native: true,
  });
  const group = (label: string) =>
    groups.find((item) => item.label === label)?.choices.map(({ value }) => value) ?? [];
  const labels = groups.flatMap(({ choices }) => choices.map(({ label }) => label));

  it('lists what is on the device, then what would fit to download', () => {
    expect(groups.map(({ label }) => label)).toEqual(['On this device', 'Download']);
    expect(group('On this device')).toEqual(['model:downloaded', 'model:sideloaded']);
    expect(group('Download')).toEqual(['provider:android-mlkit', 'catalog:minicpm5-1b-q4:1.0.0']);
    // Already downloaded, and too large for this phone.
    expect(labels).not.toContain('Gemma 4 (E4B)');
    // A provider this phone cannot run at all is not a choice.
    expect(labels).not.toContain('Apple Intelligence');
  });

  it('keeps a size beside the name rather than in it', () => {
    const sideloaded = groups[0]?.choices.find(({ value }) => value === 'model:sideloaded');
    expect(sideloaded).toMatchObject({ label: 'my-model', size: '0.5 GB' });
  });

  it('never calls a model an import or a GGUF', () => {
    const html = renderToStaticMarkup(
      <ModelChooser
        host={{ native: true } as MobileHost}
        service={{} as PortableProductService}
        providers={providers}
        selectedProviderId="llama-cpp"
        inventory={inventory}
        catalog={[minicpm, qwen, e4b]}
        busy={false}
        onProvider={async () => {}}
        refresh={async () => {}}
        reload={async () => {}}
        onError={() => {}}
        onBusyChange={() => {}}
      />,
    );
    expect(html).toContain('Add a model from Files');
    expect([html, ...labels].join('\n')).not.toMatch(/import|gguf/i);
  });

  it('shows the earlier system choice as unavailable instead of dropping it', () => {
    const gone = modelChoices({
      providers,
      selectedProviderId: 'apple-foundation-models',
      inventory: { models: [] },
      catalog: [],
      native: true,
    });
    expect(gone.groups[0]?.choices[0]).toEqual({
      value: 'provider:apple-foundation-models',
      label: 'Apple Intelligence (not available)',
      disabled: true,
    });
  });
});
