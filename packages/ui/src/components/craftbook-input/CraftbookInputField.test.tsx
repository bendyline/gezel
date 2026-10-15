import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { api } from '../../api.js';
import { CraftbookInputField, EMPTY_INPUT_VALUE } from './CraftbookInputField.js';

vi.mock('../../api.js', async () => {
  const { createMockApi } = await import('../../test-utils/mockApi.js');
  const { vi: mock } = await import('vitest');
  return {
    api: {
      ...createMockApi(),
      taskInputs: { previewTaskInput: mock.fn(), deleteInputStaging: mock.fn(async () => {}) },
    },
  };
});

const input = {
  key: 'source',
  title: 'Spreadsheet',
  required: true,
  spec: { kind: 'file' as const, accept: ['.csv'] },
};

describe('CraftbookInputField samples', () => {
  // The spreadsheet book shipped a sample a newcomer could not reach: the form
  // offered only "In this project" and "From your computer" (2026-10-12).
  it('offers the book’s sample and selects it in one tap', async () => {
    vi.mocked(api.taskInputs.previewTaskInput).mockResolvedValue({
      kind: 'file',
      drawer: 'artifacts',
      path: 'samples/shop-sales',
      label: "a small shop's monthly sales",
      fileCount: 1,
      totalBytes: 2048,
      skipped: [],
    } as never);
    const onChange = vi.fn();
    render(
      <CraftbookInputField
        projectId="default"
        craftbookId="spreadsheet-findings"
        input={input as never}
        allowUpload
        value={EMPTY_INPUT_VALUE}
        onChange={onChange}
        samples={[{ id: 'shop-sales', title: "a small shop's monthly sales" }]}
      />,
    );
    await userEvent.setup().click(screen.getByRole('radio', { name: 'Try a sample' }));
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          source: { from: 'sample', sampleId: 'shop-sales' },
          fileCount: 1,
        }),
      ),
    );
    expect(screen.getByText(/Made-up example data/)).toBeInTheDocument();
  });

  it('never offers a sample to a recurring run', () => {
    render(
      <CraftbookInputField
        projectId="default"
        craftbookId="spreadsheet-findings"
        input={input as never}
        allowUpload={false}
        value={EMPTY_INPUT_VALUE}
        onChange={vi.fn()}
        samples={[{ id: 'shop-sales', title: "a small shop's monthly sales" }]}
      />,
    );
    expect(screen.queryByRole('radio', { name: 'Try a sample' })).not.toBeInTheDocument();
  });
});
