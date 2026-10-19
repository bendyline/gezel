/** Regression coverage for readable setup requirements and unchanged install actions. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
vi.mock('../api.js', () => ({ api: createMockApi() }));
import { api } from '../api.js';
import { CraftbookToolsetSetup } from './CraftbookToolsetSetup.js';
import { craftbookDescription } from './craftbook-description.js';

describe('craftbook tool descriptions', () => {
  it('humanizes generated paths, runtime tokens, and unknown parameter names', () => {
    expect(craftbookDescription('convert {{sourceOutputPath}} to MP4 and animated GIF')).toBe(
      'convert the source document to MP4 and animated GIF',
    );
    expect(craftbookDescription('read {{ task.dir }} and {{customInputPath}}')).toBe(
      'read the task folder and custom input path',
    );
    expect(
      craftbookDescription('read {{source}}', { properties: { source: { title: 'Your draft' } } }),
    ).toBe('read Your draft');
    expect(craftbookDescription('Use MP4 or GIF.')).toBe('Use MP4 or GIF.');
  });

  it('shows the entire description and keeps optional-tool installation working', async () => {
    const onAllInstalled = vi.fn();
    const reason =
      'convert {{sourceOutputPath}} to MP4 and animated GIF with synchronized narration, then save both files in {{task.dir}}';
    vi.mocked(api.getCatalogItem).mockResolvedValue({
      manifest: { kind: 'toolset', id: 'video-export', config: [] },
    } as never);
    vi.mocked(api.installToolset).mockResolvedValue({ ok: true } as never);
    render(
      <CraftbookToolsetSetup
        missing={[{ toolsetId: 'video-export', reason }]}
        onAllInstalled={onAllInstalled}
        onCancel={() => {}}
      />,
    );
    const description = screen.getByText(
      'convert the source document to MP4 and animated GIF with synchronized narration, then save both files in the task folder',
    );
    expect(description).toBeVisible();
    expect(description.closest('[title]')).toHaveAttribute('title', description.textContent);
    expect(screen.queryByText(/\{\{/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(onAllInstalled).toHaveBeenCalledOnce());
    expect(api.installToolset).toHaveBeenCalledWith('video-export', { scope: { kind: 'shared' } });
  });
});
