import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PaneReady, RosterGezel } from './boot.js';
import type { OfficeRelay, StartRelayOptions } from './relay.js';

const listGezels = vi.fn<() => Promise<RosterGezel[]>>();
vi.mock('./boot.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./boot.js')>()),
  listGezels: () => listGezels(),
  resolveProject: vi.fn(),
}));
vi.mock('./host.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./host.js')>()),
  isRequirementSetSupported: () => true,
  documentPath: () => '/docs/plan.docx',
}));
// The pane's own logic, not Office's: a read tool always, a write tool with edits on.
vi.mock('./tools/index.js', () => ({
  toolsForHost: ({ edits }: { edits: boolean }) =>
    [{ name: 'read_document' }, ...(edits ? [{ name: 'replace_selection' }] : [])].map((tool) => ({
      ...tool,
      description: '',
      inputSchema: {},
      handler: async () => '',
    })),
}));
const startOfficeRelay = vi.fn<(opts: StartRelayOptions) => Promise<OfficeRelay>>();
vi.mock('./relay.js', () => ({
  startOfficeRelay: (opts: StartRelayOptions) => startOfficeRelay(opts),
}));

const { OfficePane, chatFrameUrl, paneSubject } = await import('./PaneApp.js');

const READY: PaneReady = {
  token: 't',
  project: { id: 'docs', name: 'Documents', readOnly: false },
  matchedBy: 'well-known',
  created: false,
  gezelId: 'lead',
  defaultProvider: 'openai',
  documentPath: '/docs/plan.docx',
  edits: true,
};

const names = (tools: { name: string }[]) => tools.map((tool) => tool.name);

function deferredRelay() {
  const update = vi.fn(async (_tools: { name: string }[]) => undefined);
  const close = vi.fn(async () => undefined);
  let resolve!: (relay: OfficeRelay) => void;
  startOfficeRelay.mockImplementation(
    () =>
      new Promise<OfficeRelay>((r) => {
        resolve = r;
      }),
  );
  return { update, close, connect: () => resolve({ update, close }) };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('OfficePane', () => {
  it('offers the document tools to the chosen gezel only', async () => {
    listGezels.mockResolvedValue([{ id: 'lead', name: 'Lead' }]);
    deferredRelay();
    render(<OfficePane ready={READY} host="word" />);
    await waitFor(() => expect(startOfficeRelay).toHaveBeenCalled());
    expect(startOfficeRelay.mock.calls[0]![0]).toMatchObject({
      projectId: 'docs',
      gezelId: 'lead',
    });
  });

  it('sends "Allow edits" switched off while the relay was still connecting', async () => {
    listGezels.mockResolvedValue([{ id: 'lead', name: 'Lead' }]);
    const relay = deferredRelay();
    render(<OfficePane ready={READY} host="word" />);
    await waitFor(() => expect(startOfficeRelay).toHaveBeenCalled());
    expect(names(startOfficeRelay.mock.calls[0]![0].tools)).toContain('replace_selection');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Allow edits' }));
    await act(async () => relay.connect());

    await waitFor(() => expect(relay.update).toHaveBeenCalled());
    expect(names(relay.update.mock.calls.at(-1)![0])).toEqual(['read_document']);
  });

  it('says plainly when the chosen gezel runs on a provider that cannot reach the document', async () => {
    listGezels.mockResolvedValue([{ id: 'lead', name: 'Lead', provider: 'copilot' }]);
    deferredRelay();
    render(<OfficePane ready={READY} host="word" />);
    expect(
      await screen.findByText(/Lead runs on Copilot, which can't reach this document/),
    ).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Lead cannot use document tools' })).toBeInTheDocument();
  });

  it('reads the install default for a gezel without its own provider', async () => {
    listGezels.mockResolvedValue([{ id: 'lead', name: 'Lead' }]);
    deferredRelay();
    render(<OfficePane ready={{ ...READY, defaultProvider: 'codex-cli' }} host="word" />);
    expect(await screen.findByText(/Lead runs on Codex CLI/)).toBeInTheDocument();
  });

  it('tells the daemon what the document is, and opens the chat on it', async () => {
    listGezels.mockResolvedValue([{ id: 'lead', name: 'Lead' }]);
    deferredRelay();
    const { container } = render(<OfficePane ready={READY} host="word" />);
    await waitFor(() => expect(startOfficeRelay).toHaveBeenCalled());
    expect(startOfficeRelay.mock.calls[0]![0].subject).toEqual({
      kind: 'document',
      app: 'Word',
      title: 'plan.docx',
      path: '/docs/plan.docx',
      focus: 'item',
      editable: true,
      stateTool: 'office_read_selection',
    });
    const src = container.querySelector('iframe')?.getAttribute('src') ?? '';
    const params = new URLSearchParams(src.slice(src.indexOf('?')));
    expect(params.get('focus')).toBe('document');
    expect(params.get('subjectKey')).toBe('file:/docs/plan.docx');
    expect(params.get('subjectTitle')).toBe('plan.docx');
  });

  it('describes an unsaved document by its pane and keeps facts, not prose', () => {
    expect(paneSubject('excel', null, false)).toEqual({
      kind: 'spreadsheet',
      app: 'Excel',
      title: 'Untitled document',
      focus: 'item',
      editable: false,
      stateTool: 'office_read_selection',
    });
    const url = chatFrameUrl('default', 'marek', 'pane-12345', {
      key: 'surface:pane-12345',
      kind: 'document',
      app: 'Word',
      title: 'Untitled document',
    });
    expect(url).toContain('subjectKey=surface%3Apane-12345');
    expect(chatFrameUrl('default', 'marek', 'pane-12345')).not.toContain('focus=');
  });

  it('shows no notice for a gezel that can use the tools', async () => {
    listGezels.mockResolvedValue([{ id: 'lead', name: 'Lead' }]);
    deferredRelay();
    render(<OfficePane ready={READY} host="word" />);
    await screen.findByRole('img', { name: 'Connecting the document…' });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
