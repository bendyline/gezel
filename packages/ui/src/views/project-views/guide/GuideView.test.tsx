import type { CodebaseMapResponse, ProjectDetail } from '@bendyline/gezel';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GuideProjectView, { guideTree } from './index.js';

vi.mock('../../../api.js', () => ({ api: { getCodebaseMap: vi.fn() } }));

const { api } = await import('../../../api.js');
const getCodebaseMap = vi.mocked(api.getCodebaseMap);

const MAP: CodebaseMapResponse = {
  indexed: true,
  architecture: 'A code editor built on web technology.',
  areas: [
    { path: '.', depth: 0, purpose: 'Build and packaging scripts.', keyFiles: [] },
    {
      path: 'src',
      depth: 0,
      purpose: 'The editor itself.',
      keyFiles: [
        { path: 'src/brackets.js', purpose: 'Boots the application.' },
        { path: 'src/editor', purpose: 'Listed as a folder, not a file.' },
      ],
    },
    {
      path: 'src/editor',
      depth: 1,
      purpose: 'Text editing on top of CodeMirror.',
      keyFiles: [{ path: 'src/editor/Editor.js', purpose: 'One open editor.' }],
    },
    { path: 'test', depth: 0, purpose: 'Unit and integration tests.', keyFiles: [] },
  ],
  loadBearing: [{ path: 'src/utils/StringUtils.js', importers: 42, purpose: 'String helpers.' }],
};

const project = { id: 'p1', name: 'Brackets', packages: [] } as unknown as ProjectDetail;

function renderGuide(overrides: { selectedPath?: string | null } = {}) {
  const onSelectPath = vi.fn();
  const setInspectorExtras = vi.fn();
  render(
    <GuideProjectView
      projectId="p1"
      project={project}
      compact={false}
      selectedPath={overrides.selectedPath ?? null}
      onSelectPath={onSelectPath}
      setInspectorExtras={setInspectorExtras}
    />,
  );
  return { onSelectPath, setInspectorExtras };
}

beforeEach(() => {
  getCodebaseMap.mockReset();
});

describe('guideTree', () => {
  it('nests each folder under the nearest folder that has a summary', () => {
    const tree = guideTree([
      { path: 'src', depth: 0, purpose: '', keyFiles: [] },
      { path: 'src/a/b', depth: 2, purpose: '', keyFiles: [] },
      { path: 'docs', depth: 0, purpose: '', keyFiles: [] },
    ]);
    expect(tree.map((n) => n.area.path)).toEqual(['src', 'docs']);
    expect(tree[0]?.children.map((n) => n.area.path)).toEqual(['src/a/b']);
  });
});

describe('the Guide view', () => {
  it('says what the project is and what each folder is for', async () => {
    getCodebaseMap.mockResolvedValue(MAP);
    const { setInspectorExtras } = renderGuide();

    expect(await screen.findByText('A code editor built on web technology.')).toBeTruthy();
    expect(screen.getByText('Files at the root')).toBeTruthy();
    expect(screen.getByText('The editor itself.')).toBeTruthy();
    expect(screen.getByText('Unit and integration tests.')).toBeTruthy();
    expect(getCodebaseMap).toHaveBeenCalledWith('p1');
    expect(setInspectorExtras).toHaveBeenCalledWith(null);
  });

  it('opens top-level folders on arrival and lists their key files once', async () => {
    getCodebaseMap.mockResolvedValue(MAP);
    renderGuide();

    const where = (await screen.findByRole('heading', { name: 'Where things live' }))
      .parentElement as HTMLElement;
    const src = within(where).getByRole('button', { name: /^src\// });
    expect(src.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /^brackets\.js/ })).toBeTruthy();
    // The key-file entry naming a subfolder is not repeated as a file.
    expect(screen.queryByText('Listed as a folder, not a file.')).toBeNull();

    const editor = screen.getByRole('button', { name: /^editor\// });
    expect(editor.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('One open editor.')).toBeNull();
    fireEvent.click(editor);
    expect(screen.getByText('One open editor.')).toBeTruthy();

    fireEvent.click(src);
    expect(src.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: /^brackets\.js/ })).toBeNull();
  });

  it('opens a file in the shared inspector', async () => {
    getCodebaseMap.mockResolvedValue(MAP);
    const { onSelectPath } = renderGuide({ selectedPath: 'src/brackets.js' });

    const file = await screen.findByRole('button', { name: /^brackets\.js/ });
    expect(file.getAttribute('aria-current')).toBe('true');
    fireEvent.click(file);
    expect(onSelectPath).toHaveBeenCalledWith('src/brackets.js');
  });

  it('lists the files the rest leans on, with how many import each', async () => {
    getCodebaseMap.mockResolvedValue(MAP);
    const { onSelectPath } = renderGuide();

    const section = (await screen.findByRole('heading', { name: 'What the rest leans on' }))
      .parentElement as HTMLElement;
    const row = within(section).getByRole('button', { name: /StringUtils\.js/ });
    expect(row.textContent).toContain('imported by 42');
    fireEvent.click(row);
    expect(onSelectPath).toHaveBeenCalledWith('src/utils/StringUtils.js');
  });

  it('says plainly when the folder has not been mapped yet', async () => {
    getCodebaseMap.mockResolvedValue({ indexed: false, areas: [], loadBearing: [] });
    renderGuide();

    expect(await screen.findByText(/hasn’t mapped this folder yet/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Where things live' })).toBeNull();
  });

  it('reports a failed load and loads again on Refresh', async () => {
    getCodebaseMap.mockRejectedValueOnce(new Error('daemon is busy'));
    getCodebaseMap.mockResolvedValueOnce(MAP);
    renderGuide();

    expect(await screen.findByText(/daemon is busy/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('The editor itself.')).toBeTruthy();
    expect(getCodebaseMap).toHaveBeenCalledTimes(2);
  });
});
