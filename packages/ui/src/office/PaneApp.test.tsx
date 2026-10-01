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

const { OfficePane } = await import('./PaneApp.js');

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

  it('shows no notice for a gezel that can use the tools', async () => {
    listGezels.mockResolvedValue([{ id: 'lead', name: 'Lead' }]);
    deferredRelay();
    render(<OfficePane ready={READY} host="word" />);
    await screen.findByRole('img', { name: 'Connecting the document…' });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
