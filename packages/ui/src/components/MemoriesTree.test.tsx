import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { MemoriesTree, ProjectMemoriesEditor, UserMemoriesEditor } = await import(
  './MemoriesTree.js'
);
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
    const editor = await screen.findByRole('textbox', { name: 'Lyudmyla memory for 2026-08-04' });
    expect(editor).toHaveValue('Personal memory');
    expect(api.readMemoryDay).toHaveBeenCalledWith('gezel', 'lyudmyla', '2026-08-04');

    fireEvent.change(editor, { target: { value: 'Corrected memory' } });
    await waitFor(
      () =>
        expect(api.updateMemoryDay).toHaveBeenCalledWith(
          'gezel',
          'lyudmyla',
          '2026-08-04',
          'Corrected memory',
        ),
      { timeout: 1800 },
    );
  });

  it('lets the person write the lessons, saying which lines are kept', async () => {
    render(<MemoriesTree gezelId="lyudmyla" gezelName="Lyudmyla" />);

    fireEvent.click(await screen.findByRole('button', { name: 'lessons' }));
    const editor = await screen.findByRole('textbox', { name: 'Lyudmyla lessons' });
    expect(editor).toHaveValue('# Lessons');
    expect(screen.getByText(/kept exactly as written/)).toBeInTheDocument();

    fireEvent.change(editor, { target: { value: '## Pinned\n\n- Answer in Dutch.' } });
    await waitFor(
      () =>
        expect(api.writeMemoryLessons).toHaveBeenCalledWith(
          'lyudmyla',
          '## Pinned\n\n- Answer in Dutch.',
        ),
      { timeout: 1800 },
    );
  });
});

describe('UserMemoriesEditor', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(api.listMemoryDays).mockResolvedValue({ days: ['2026-10-07'] });
    vi.mocked(api.readMemoryDay).mockResolvedValue({
      content: '## 08:00 [pref]\n\nTea, not coffee.\n',
    });
  });

  it('edits what the crew knows about the person in the shared scope', async () => {
    render(<UserMemoriesEditor />);

    expect(await screen.findByText('About you')).toBeInTheDocument();
    const editor = await screen.findByRole('textbox', { name: 'About you memory for 2026-10-07' });
    expect(api.listMemoryDays).toHaveBeenCalledWith('user', 'user');
    fireEvent.change(editor, { target: { value: '## 08:00 [pref]\n\nCoffee after all.\n' } });
    await waitFor(
      () =>
        expect(api.updateMemoryDay).toHaveBeenCalledWith(
          'user',
          'user',
          '2026-10-07',
          '## 08:00 [pref]\n\nCoffee after all.\n',
        ),
      { timeout: 1800 },
    );
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
