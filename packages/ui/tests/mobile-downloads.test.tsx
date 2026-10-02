import type { MobileModelDownload, MobileModelSource } from '@bendyline/gezel/mobile-providers';
import type { PortableCatalogModel, PortableProductService } from '@bendyline/gezel/runtime';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ModelChooser } from '../../mobile/src/ModelChooser.js';
import type { MobileHost } from '../../mobile/src/native.js';

vi.mock(
  '../src/primitives/Select.js',
  async () => (await import('../src/test-utils/primitivesMock.js')).primitivesMock.Select,
);

const source = {
  catalogId: 'small',
  catalogVersion: '1.0.0',
  sourceId: 'gguf',
  huggingfaceRepo: 'owner/model',
  revision: 'a'.repeat(40),
  filename: 'model.gguf',
  sha256: 'b'.repeat(64),
};
const model: PortableCatalogModel = { name: 'Small model', approxSizeBytes: 999, source };
const exact: MobileModelSource = { ...source, sizeBytes: 1000 };
const started: MobileModelDownload = {
  id: 'download-1',
  name: 'Small model',
  state: 'downloading',
  downloadedBytes: 0,
  source: exact,
} as MobileModelDownload;

function fixture() {
  const host = {
    native: true,
    listModelDownloads: vi.fn(async (): Promise<MobileModelDownload[]> => []),
    resolveModelSource: vi.fn(async () => exact),
    cancelModelSourceResolution: vi.fn(async () => {}),
    startModelDownload: vi.fn(async () => started),
    removeModelDownload: vi.fn(async () => {}),
    selectModel: vi.fn(async () => ({})),
  };
  const readConfig = vi.fn(async () => ({}));
  const onProvider = vi.fn(async () => {});
  const onError = vi.fn();
  const mount = () =>
    render(
      <ModelChooser
        host={host as unknown as MobileHost}
        service={{ store: { readConfig } } as unknown as PortableProductService}
        providers={[]}
        selectedProviderId="llama-cpp"
        inventory={{ models: [] }}
        catalog={[model]}
        busy={false}
        onProvider={onProvider}
        refresh={async () => {}}
        reload={async () => {}}
        onError={onError}
        onBusyChange={() => {}}
      />,
    );
  const choose = () =>
    fireEvent.change(screen.getByTestId('mock-select'), {
      target: { value: 'catalog:small:1.0.0' },
    });
  return { host, readConfig, onProvider, onError, mount, choose };
}
const denied = {
  securityPolicy: {
    level: 'super-lockdown',
    allowFileEdits: false,
    allowExternalChat: false,
    allowExternalServices: false,
    allowScriptExecution: false,
    allowAppNetwork: false,
  },
};

describe('downloading from the model list', () => {
  it('offers the download without starting it before the person picks it', async () => {
    const { host, mount } = fixture();
    mount();
    expect(screen.getByRole('option', { name: 'Small model' })).toBeInTheDocument();
    await waitFor(() => expect(host.listModelDownloads).toHaveBeenCalled());
    expect(host.resolveModelSource).not.toHaveBeenCalled();
    expect(host.startModelDownload).not.toHaveBeenCalled();
  });

  it('starts the exact source when picked, and selects the model only once it lands', async () => {
    const { host, onProvider, mount, choose } = fixture();
    mount();
    choose();
    await waitFor(() => expect(host.startModelDownload).toHaveBeenCalledWith(exact, 'Small model'));
    expect(host.resolveModelSource).toHaveBeenCalledWith(source);
    expect(host.selectModel).not.toHaveBeenCalled();

    host.listModelDownloads.mockResolvedValue([
      { ...started, state: 'complete', modelId: 'small-model' } as MobileModelDownload,
    ]);
    await waitFor(() => expect(host.selectModel).toHaveBeenCalledWith('small-model'), {
      timeout: 3000,
    });
    expect(onProvider).toHaveBeenCalledWith('llama-cpp');
    expect(host.removeModelDownload).toHaveBeenCalledWith('download-1');
  });

  it('does not access the network under the offline policy', async () => {
    const { host, readConfig, onError, mount, choose } = fixture();
    readConfig.mockResolvedValue(denied);
    mount();
    choose();
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('Network access is off') }),
      ),
    );
    expect(host.resolveModelSource).not.toHaveBeenCalled();
  });

  it('does not start after Cancel even if a late native resolution succeeds', async () => {
    const { host, mount, choose } = fixture();
    let resolve!: (source: MobileModelSource) => void;
    host.resolveModelSource.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    mount();
    choose();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await act(async () => resolve(exact));
    expect(host.cancelModelSourceResolution).toHaveBeenCalledOnce();
    expect(host.startModelDownload).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('checks policy again after native source resolution', async () => {
    const { host, readConfig, onError, mount, choose } = fixture();
    host.resolveModelSource.mockImplementation(async () => {
      readConfig.mockResolvedValue(denied);
      return exact;
    });
    mount();
    choose();
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Network access was turned off'),
        }),
      ),
    );
    expect(host.startModelDownload).not.toHaveBeenCalled();
  });
});
