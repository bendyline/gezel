import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { MemoriesTree, ProjectMemoriesEditor } = await import('./MemoriesTree.js');
const { api } = await import('../api.js');

describe('MemoriesTree', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(api.listMemoryDays).mockResolvedValue({ days: ['2026-08-04'] });
    vi.mocked(api.readMemorySummary).mockResolvedValue({ content: '' });
    vi.mocked(api.readMemoryLessons).mockResolvedValue({ content: '# Lessons' });
    vi.mocked(api.readMemoryDay).mockResolvedValue({ content: 'Personal memory' });
  });

  it('loads only the selected gezel memory scope', async () => {
    render(<MemoriesTree gezelId="lyudmyla" gezelName="Lyudmyla" />);

    const day = await screen.findByRole('button', { name: '2026-08-04' });
    expect(api.listMemoryDays).toHaveBeenCalledTimes(1);
    expect(api.listMemoryDays).toHaveBeenCalledWith('gezel', 'lyudmyla');
    expect(api.listProjects).not.toHaveBeenCalled();

    fireEvent.click(day);
    await screen.findByText('Personal memory');
    expect(api.readMemoryDay).toHaveBeenCalledWith('gezel', 'lyudmyla', '2026-08-04');
  });
});

describe('ProjectMemoriesEditor', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(api.listMemoryDays).mockResolvedValue({ days: ['2026-08-04'] });
    vi.mocked(api.readMemoryDay).mockResolvedValue({
      content: '## 08:15 [decision]\n\nOriginal project memory.\n',
    });
    vi.mocked(api.updateMemoryDay).mockResolvedValue({ ok: true, indexed: true });
  });

  it('shows project days and autosaves edits to the project scope', async () => {
    render(<ProjectMemoriesEditor projectId="alpha" projectName="Alpha" />);

    expect(await screen.findByText('Project memories')).toBeInTheDocument();
    const editor = await screen.findByRole('textbox', {
      name: 'Alpha memory for 2026-08-04',
    });
    expect(editor).toHaveValue('## 08:15 [decision]\n\nOriginal project memory.\n');

    fireEvent.change(editor, {
      target: { value: '## 09:30 [fact]\n\nEdited project memory.\n' },
    });
    await waitFor(
      () => {
        expect(api.updateMemoryDay).toHaveBeenCalledWith(
          'project',
          'alpha',
          '2026-08-04',
          '## 09:30 [fact]\n\nEdited project memory.\n',
        );
      },
      { timeout: 1800 },
    );
  });
});
