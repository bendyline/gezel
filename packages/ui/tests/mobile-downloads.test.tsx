import type { MobileModelSource } from '@bendyline/gezel/mobile-providers';
import type { PortableCatalogModel, PortableProductService } from '@bendyline/gezel/runtime';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ModelDownloads } from '../../mobile/src/ModelDownloads.js';
import type { MobileHost } from '../../mobile/src/native.js';

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
function fixture() {
  const host = {
    native: true,
    listModelDownloads: vi.fn(async () => []),
    resolveModelSource: vi.fn(async () => exact),
    cancelModelSourceResolution: vi.fn(async () => {}),
    startModelDownload: vi.fn(async () => {}),
    selectModel: vi.fn(),
  };
  const readConfig = vi.fn(async () => ({}));
  const mount = (setup = false) => {
    const rendered = render(
      <ModelDownloads
        host={host as unknown as MobileHost}
        service={{ store: { readConfig } } as unknown as PortableProductService}
        models={[model]}
        disabled={false}
        onInstalled={vi.fn()}
        setup={setup}
      />,
    );
    if (!setup) fireEvent.click(screen.getByText('Download a model'));
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'small:1.0.0' } });
    return rendered;
  };
  return { host, readConfig, mount };
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

describe('model download controls', () => {
  it('shows the first-run picker without starting a download before the user asks', async () => {
    const { host, mount } = fixture();
    mount(true);
    expect(screen.getByText('Download a model').closest('details')).toHaveAttribute('open');
    expect(screen.getByLabelText('Model')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Download' })).toBeVisible();
    await waitFor(() => expect(host.listModelDownloads).toHaveBeenCalled());
    expect(host.resolveModelSource).not.toHaveBeenCalled();
    expect(host.startModelDownload).not.toHaveBeenCalled();
  });
  it('resolves the immutable source to its exact length without auto-selecting it', async () => {
    const { host, mount } = fixture();
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(host.startModelDownload).toHaveBeenCalledWith(exact, 'Small model'));
    expect(host.resolveModelSource).toHaveBeenCalledWith(source);
    expect(host.selectModel).not.toHaveBeenCalled();
  });
  it('does not access the network under the offline policy', async () => {
    const { host, readConfig, mount } = fixture();
    readConfig.mockResolvedValue(denied);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Network access is off');
    expect(host.resolveModelSource).not.toHaveBeenCalled();
  });
  it('does not start after Cancel even if a late native resolution succeeds', async () => {
    const { host, mount } = fixture();
    let resolve!: (source: MobileModelSource) => void;
    host.resolveModelSource.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await act(async () => resolve(exact));
    expect(host.cancelModelSourceResolution).toHaveBeenCalledOnce();
    expect(host.startModelDownload).not.toHaveBeenCalled();
  });
  it('checks policy again after native source resolution', async () => {
    const { host, readConfig, mount } = fixture();
    host.resolveModelSource.mockImplementation(async () => {
      readConfig.mockResolvedValue(denied);
      return exact;
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Network access was turned off');
    expect(host.startModelDownload).not.toHaveBeenCalled();
  });
});
