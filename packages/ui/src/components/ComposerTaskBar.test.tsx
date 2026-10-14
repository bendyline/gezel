import type { CraftbookTemplateManifest, PromptDraftTaskLaunch } from '@bendyline/gezel';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ComposerTaskBar } from './ComposerTaskBar.js';
import { pickableInputs } from './composer-task-launch.js';
import type { CraftbookCatalogArt } from './craftbook-catalog-art.js';

const manifest = {
  kind: 'craftbook-template',
  id: 'spreadsheet-findings',
  name: 'Make sense of a spreadsheet',
  paramSchema: {
    type: 'object',
    required: ['source'],
    properties: {
      source: { type: 'string', title: 'Spreadsheet', input: { kind: 'file', accept: ['.csv'] } },
    },
  },
  samples: [
    {
      id: 'shop-sales',
      title: "a small shop's monthly sales",
      param: 'source',
      files: ['samples/shop-sales/sales.csv'],
    },
  ],
  steps: [{ id: 'read', name: 'Read' }],
  entryStepId: 'read',
} as unknown as CraftbookTemplateManifest;

const art = { manifest, item: {} } as unknown as CraftbookCatalogArt;

const launch: PromptDraftTaskLaunch = {
  craftbookId: 'spreadsheet-findings',
  params: {},
  inputs: { source: { from: 'sample', sampleId: 'shop-sales' } },
  origin: 'user',
};

function renderBar(overrides: Partial<Parameters<typeof ComposerTaskBar>[0]> = {}) {
  const onPickInput = vi.fn();
  render(
    <ComposerTaskBar
      launch={launch}
      art={art}
      readiness={{ ready: true }}
      stale={[]}
      pickable={pickableInputs(launch, manifest)}
      onPickInput={onPickInput}
      onOpen={() => {}}
      onDismiss={() => {}}
      {...overrides}
    />,
  );
  return { onPickInput };
}

describe('ComposerTaskBar', () => {
  it('names the sample and offers a file of your own, filtered to what the plan reads', () => {
    const { onPickInput } = renderBar();
    expect(screen.getByText("source: a small shop's monthly sales (sample)")).toBeTruthy();
    const key = screen.getByRole('button', { name: 'Use your own file…' });
    const input = key.nextElementSibling as HTMLInputElement;
    expect(input.type).toBe('file');
    expect(input.accept).toBe('.csv');
    const file = new File(['a,b\n1,2\n'], 'q3.csv', { type: 'text/csv' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onPickInput).toHaveBeenCalledWith('source', {
      label: 'q3.csv',
      files: [{ file, relPath: 'q3.csv' }],
    });
  });

  it('disables the key while the pick uploads', () => {
    renderBar({ picking: { key: 'source', progress: { done: 0, total: 1 } } });
    expect((screen.getByRole('button', { name: 'Uploading…' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('says why a pick was refused', () => {
    renderBar({
      picking: { key: 'source', error: 'Nothing here is a file this craftbook reads.' },
    });
    expect(screen.getByRole('alert').textContent).toBe(
      'Nothing here is a file this craftbook reads.',
    );
    expect(screen.getByRole('button', { name: 'Use your own file…' })).toBeTruthy();
  });

  it('offers no key once the person has chosen their own file', () => {
    const chosen: PromptDraftTaskLaunch = {
      ...launch,
      inputs: { source: { from: 'upload', stagingId: 'stg-abcdefgh' } },
      inputLabels: { source: { label: 'q3.csv', fileCount: 1 } },
    };
    renderBar({ launch: chosen, pickable: pickableInputs(chosen, manifest) });
    expect(screen.queryByRole('button', { name: /your own|Choose file/ })).toBeNull();
    expect(screen.getByText('source: q3.csv (1 file)')).toBeTruthy();
  });
});
