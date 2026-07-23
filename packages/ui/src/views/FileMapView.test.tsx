import type {
  FileContextResponse,
  FileMapResponse,
  MapBlock,
  MapBuilding,
  SecurityFindingWire,
} from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../theme.js', () => ({ useEffectiveTheme: () => 'dark' }));

// The canvas map is its own component (tested separately) — mock it as a flat
// list of clickable blocks so we can drive selection.
vi.mock('../components/FileMap/FileMap.js', () => ({
  defaultRenderer: () => 'iso',
  FileMap: ({
    model,
    onSelect,
  }: {
    model: FileMapResponse;
    onSelect: (b: MapBlock, building?: MapBuilding) => void;
  }) => (
    <div data-testid="filemap-stub">
      {model.blocks.map((b) => (
        <button key={b.id} type="button" data-testid={`block-${b.id}`} onClick={() => onSelect(b)}>
          {b.label}
        </button>
      ))}
      {model.buildings.map((building) => (
        <button
          key={building.id}
          type="button"
          data-testid={`building-${building.id}`}
          onClick={() => onSelect(model.blocks.find((b) => b.id === building.blockId)!, building)}
        >
          {building.label}
        </button>
      ))}
    </div>
  ),
}));

// EditorShell stub: records the codeContext prop and exposes a button that
// simulates a section link click so we can assert map navigation.
interface RecordedShellProps {
  initialMarkdown?: string;
  fileName?: string;
  language?: string;
  colorScheme?: 'light' | 'dark';
  readOnly?: boolean;
  toolbarSlotLeft?: ReactNode;
  codeContext?: {
    sections: Array<{ id: string }>;
    onLinkClick?: (href: string, meta: { sectionId: string }) => boolean | undefined;
  };
}
const shellProps: RecordedShellProps[] = [];
const monacoEditor = {
  getModel: vi.fn(() => ({ getLineCount: () => 100, getLineMaxColumn: () => 40 })),
  revealLineInCenter: vi.fn(),
  setPosition: vi.fn(),
  deltaDecorations: vi.fn(() => []),
};
vi.mock('@bendyline/squisq-editor-react', () => ({
  useEditorContext: () => ({ monacoEditor }),
  EditorShell: (props: RecordedShellProps) => {
    shellProps.push(props);
    return (
      <div data-testid="editor-stub" data-sections={props.codeContext?.sections.length ?? -1}>
        {props.toolbarSlotLeft}
        <button
          type="button"
          data-testid="ctx-link"
          onClick={() =>
            props.codeContext?.onLinkClick?.(`gezel-nav:${encodeURIComponent('src/b.ts')}`, {
              sectionId: 'x',
            })
          }
        >
          link
        </button>
      </div>
    );
  },
}));
vi.mock('@bendyline/squisq-editor-react/styles', () => ({}));

import { api } from '../api.js';
import { FileMapView } from './FileMapView.js';

const block = (id: string): MapBlock => ({
  id,
  districtId: 'root',
  rect: { x: 0, y: 0, w: 10, h: 10 },
  label: id.slice(id.lastIndexOf('/') + 1),
  weight: 20,
  lang: id.endsWith('.ts') ? 'typescript' : null,
  state: 'live',
  buildingCount: 1,
});

const MODEL: FileMapResponse = {
  domain: 'code',
  root: '/r',
  bounds: { x: 0, y: 0, w: 100, h: 100 },
  builtAt: '2026-07-06T00:00:00Z',
  indexed: true,
  districts: [],
  blocks: [block('src/a.ts'), block('src/b.ts')],
  buildings: [
    {
      id: 'src/a.ts#run',
      blockId: 'src/a.ts',
      rect: { x: 1, y: 1, w: 3, h: 3 },
      height: 0.5,
      lines: 5,
      lineStart: 2,
      lineEnd: 6,
      label: 'run',
      kind: 'function',
    },
  ],
  roads: [{ a: 'src/a.ts', b: 'src/b.ts', affinity: 1, source: 'import', bidirectional: false }],
};

const CONTEXT: FileContextResponse = {
  path: 'src/a.ts',
  lang: 'typescript',
  totalLines: 10,
  summary: null,
  importedBy: [{ path: 'src/b.ts', names: ['run'] }],
  importedByTruncated: false,
  imports: [],
  fileFindings: [],
  symbols: [
    {
      name: 'run',
      kind: 'function',
      lineStart: 2,
      lineEnd: 6,
      importedBy: [{ path: 'src/b.ts', viaBinding: true }],
      importedByTruncated: false,
      uses: [],
      usedInFileBy: [],
      findings: [],
    },
  ],
  symbolsTruncated: false,
  engine: 'index',
};

const FINDING: SecurityFindingWire = {
  fingerprint: 'sink.eval:src/a.ts:2',
  path: 'src/a.ts',
  line: 2,
  ruleId: 'sink.eval',
  category: 'injection',
  severity: 'high',
  source: 'builtin',
  title: 'Dynamic code execution can run untrusted input',
  evidence: 'eval(input)',
  status: 'open',
};

beforeEach(() => {
  vi.clearAllMocks();
  delete window.__GEZEL__?.openWorkspaceFile;
  shellProps.length = 0;
  vi.mocked(api.toolFileMap).mockResolvedValue(MODEL);
  vi.mocked(api.listProjectGithubPulls).mockResolvedValue({ pulls: [] });
  vi.mocked(api.readProjectWorkspaceFile).mockImplementation(async (_id, path: string) => ({
    path,
    content: 'export function run() {}\n',
  }));
  vi.mocked(api.toolFileContext).mockResolvedValue(CONTEXT);
  vi.mocked(api.toolScanFindings).mockResolvedValue({
    findings: [],
    counts: { total: 0, bySeverity: {}, byCategory: {}, bySource: {} },
    truncated: false,
    indexed: true,
  });
});

async function openBlock(id: string) {
  render(<FileMapView projectId="p1" />);
  await screen.findByTestId(`block-${id}`);
  fireEvent.click(screen.getByTestId(`block-${id}`));
  await screen.findByTestId('editor-stub');
}

describe('FileMapView code context', () => {
  it('passes the indexed language and effective theme to the read-only Squisq editor', async () => {
    await openBlock('src/a.ts');
    const last = shellProps.at(-1)!;
    expect(last).toMatchObject({
      initialMarkdown: 'export function run() {}\n',
      fileName: 'src/a.ts',
      language: 'typescript',
      colorScheme: 'dark',
      readOnly: true,
    });
  });

  it('reveals the declaration line when a symbol building is selected', async () => {
    render(<FileMapView projectId="p1" />);
    await screen.findByTestId('building-src/a.ts#run');
    fireEvent.click(screen.getByTestId('building-src/a.ts#run'));
    await screen.findByTestId('editor-stub');
    await waitFor(() => {
      expect(monacoEditor.setPosition).toHaveBeenLastCalledWith({ lineNumber: 2, column: 1 });
      expect(monacoEditor.revealLineInCenter).toHaveBeenLastCalledWith(2);
    });
  });

  it('opens the real workspace file when an embedding editor provides that capability', async () => {
    const openWorkspaceFile = vi.fn();
    window.__GEZEL__ = { ...window.__GEZEL__!, openWorkspaceFile };
    render(<FileMapView projectId="p1" />);
    await screen.findByTestId('building-src/a.ts#run');
    fireEvent.click(screen.getByTestId('building-src/a.ts#run'));

    expect(openWorkspaceFile).toHaveBeenCalledWith('src/a.ts', 2);
    expect(api.readProjectWorkspaceFile).not.toHaveBeenCalled();
    expect(screen.queryByTestId('editor-stub')).toBeNull();
  });

  it('fetches file content and context in parallel and passes composed sections', async () => {
    await openBlock('src/a.ts');
    expect(api.readProjectWorkspaceFile).toHaveBeenCalledWith('p1', 'src/a.ts');
    expect(api.toolFileContext).toHaveBeenCalledWith('p1', { path: 'src/a.ts' });
    await waitFor(() => {
      expect(screen.getByTestId('editor-stub').dataset.sections).toBe('1');
    });
    const last = shellProps.at(-1)!;
    expect(last.codeContext!.sections[0]!.id).toBe('run@2');
  });

  it('renders the plain editor with no error UI when context is unavailable', async () => {
    vi.mocked(api.toolFileContext).mockRejectedValue(
      Object.assign(new Error('404'), { status: 404 }),
    );
    await openBlock('src/a.ts');
    // editor present, no sections, and no error text anywhere
    expect(screen.getByTestId('editor-stub').dataset.sections).toBe('-1');
    expect(screen.queryByText(/Couldn’t/)).toBeNull();
  });

  it('a gezel-nav section link navigates the map to that block', async () => {
    await openBlock('src/a.ts');
    await waitFor(() => expect(screen.getByTestId('editor-stub').dataset.sections).toBe('1'));
    fireEvent.click(screen.getByTestId('ctx-link'));
    await waitFor(() => {
      expect(api.readProjectWorkspaceFile).toHaveBeenCalledWith('p1', 'src/b.ts');
    });
  });

  it('serves a repeat visit from the cache (one fetch per path)', async () => {
    await openBlock('src/a.ts');
    await waitFor(() => expect(screen.getByTestId('editor-stub').dataset.sections).toBe('1'));
    // hop to b and back to a
    fireEvent.click(screen.getByTestId('block-src/b.ts'));
    await waitFor(() =>
      expect(api.toolFileContext).toHaveBeenCalledWith('p1', { path: 'src/b.ts' }),
    );
    fireEvent.click(screen.getByTestId('block-src/a.ts'));
    await waitFor(() => expect(screen.getByTestId('editor-stub').dataset.sections).toBe('1'));
    const aCalls = vi
      .mocked(api.toolFileContext)
      .mock.calls.filter(([, body]) => (body as { path: string }).path === 'src/a.ts');
    expect(aCalls.length).toBe(1);
  });

  it('shows a finding, reveals and highlights its impacted line', async () => {
    vi.mocked(api.toolScanFindings).mockResolvedValue({
      findings: [FINDING],
      counts: { total: 1, bySeverity: { high: 1 }, byCategory: {}, bySource: {} },
      truncated: false,
      indexed: true,
    });
    await openBlock('src/a.ts');

    expect(await screen.findByText(FINDING.title)).toBeInTheDocument();
    expect(screen.getByText('eval(input)')).toBeInTheDocument();
    await waitFor(() => {
      expect(monacoEditor.setPosition).toHaveBeenLastCalledWith({ lineNumber: 2, column: 1 });
      expect(monacoEditor.deltaDecorations).toHaveBeenCalledWith(
        expect.any(Array),
        expect.arrayContaining([
          expect.objectContaining({
            range: expect.objectContaining({ startLineNumber: 2 }),
            options: expect.objectContaining({ className: 'filemap-finding-line-active' }),
          }),
        ]),
      );
    });
  });

  it('marks a finding resolved and refreshes the map so its fire can go out', async () => {
    vi.mocked(api.toolScanFindings)
      .mockResolvedValueOnce({
        findings: [FINDING],
        counts: { total: 1, bySeverity: { high: 1 }, byCategory: {}, bySource: {} },
        truncated: false,
        indexed: true,
      })
      .mockResolvedValue({
        findings: [],
        counts: { total: 0, bySeverity: {}, byCategory: {}, bySource: {} },
        truncated: false,
        indexed: true,
      });
    vi.mocked(api.resolveSecurityFinding).mockResolvedValue({ resolved: true });
    await openBlock('src/a.ts');
    await screen.findByText(FINDING.title);

    fireEvent.click(screen.getByRole('button', { name: 'Mark resolved' }));
    await waitFor(() => {
      expect(api.resolveSecurityFinding).toHaveBeenCalledWith('p1', {
        fingerprint: FINDING.fingerprint,
      });
      expect(screen.queryByText(FINDING.title)).toBeNull();
      expect(api.toolFileMap).toHaveBeenCalledTimes(2);
    });
  });

  it('delegates a finding to a developer gezel task', async () => {
    vi.mocked(api.toolScanFindings).mockResolvedValue({
      findings: [FINDING],
      counts: { total: 1, bySeverity: { high: 1 }, byCategory: {}, bySource: {} },
      truncated: false,
      indexed: true,
    });
    vi.mocked(api.delegateSecurityFinding).mockResolvedValue({
      finding: { ...FINDING, status: 'in_progress', taskRef: 'p1/1' },
      taskRef: 'p1/1',
      gezelId: 'dev-1',
      gezelName: 'Ada',
      enqueued: true,
    });
    vi.mocked(api.getTaskByRef).mockRejectedValue(new Error('not polled in this assertion'));
    await openBlock('src/a.ts');
    await screen.findByText(FINDING.title);

    fireEvent.click(screen.getByRole('button', { name: 'Ask a developer gezel' }));
    expect(await screen.findByText('Developer gezel working · p1/1')).toBeInTheDocument();
    expect(api.delegateSecurityFinding).toHaveBeenCalledWith('p1', {
      fingerprint: FINDING.fingerprint,
    });
    expect(screen.getByRole('button', { name: 'Developer working' })).toBeDisabled();
  });
});
