import type { PortableProductService } from '@bendyline/gezel/runtime';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ModelBudgetSettings } from '../../mobile/src/ModelBudgetSettings.js';
import { ProductModelSettings } from '../../mobile/src/ProductModelSettings.js';
import type { MobileHost } from '../../mobile/src/native.js';

vi.mock(
  '@bendyline/gezel/mobile-providers',
  () => import('../../core/src/schemas/mobile-provider.js'),
);

type Status = { busy: boolean; pendingSave: boolean; changingModel: boolean };
function fixture() {
  let status: Status = { busy: false, pendingSave: false, changingModel: false };
  const listeners = new Set<() => void>();
  const update = (next: Partial<Status>) => {
    status = { ...status, ...next };
    for (const listener of listeners) listener();
  };
  const service = {
    getStatus: () => status,
    subscribeStatus: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    withModelChange: vi.fn(async <T,>(action: () => Promise<T>) => action()),
    setProvider: vi.fn(async () => {}),
    retrySave: vi.fn(async () => {
      update({ pendingSave: false });
    }),
    store: { readConfig: vi.fn(async () => ({ provider: 'llama-cpp' })), writeConfig: vi.fn() },
  };
  const host = {
    native: true,
    files: {},
    inference: {
      providers: vi.fn(async () => [
        {
          id: 'llama-cpp',
          name: 'Imported model',
          availability: 'available',
          contextTokens: 8192,
          maxOutputTokens: 4096,
        },
        {
          id: 'apple-foundation-models',
          name: 'Apple Intelligence',
          availability: 'available',
          contextTokens: 4096,
          maxOutputTokens: 1024,
        },
        { id: 'android-mlkit', name: 'Android on-device AI', availability: 'download-required' },
      ]),
    },
    listModels: vi.fn(async () => ({ models: [] })),
    importModel: vi.fn(async () => ({ model: null })),
    selectModel: vi.fn(async () => ({ model: { id: 'one' } })),
    removeModel: vi.fn(async () => {}),
    prepareProvider: vi.fn(async () => {}),
    cancelProviderPreparation: vi.fn(async () => {}),
  };
  const mount = () =>
    render(
      <ProductModelSettings
        host={host as unknown as MobileHost}
        service={service as unknown as PortableProductService}
      />,
    );
  return { host, service, update, mount };
}

describe('host model settings product boundary', () => {
  it('reacts to native activity and only offers recovery while a reply is unsaved', async () => {
    const f = fixture();
    f.mount();
    await screen.findByRole('option', { name: 'Apple Intelligence' });
    const picker = screen.getByLabelText('Use a model');
    expect(picker).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Retry saving' })).toBeNull();
    act(() => f.update({ busy: true }));
    expect(picker).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Import a model' })).toBeDisabled();
    act(() => f.update({ busy: false, pendingSave: true }));
    expect(picker).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry saving' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry saving' })).toBeNull());
    expect(f.service.retrySave).toHaveBeenCalledOnce();
    await waitFor(() => expect(picker).not.toBeDisabled());
  });
  it('changes the provider through service admission and guards native model mutations', async () => {
    const f = fixture();
    f.mount();
    await screen.findByRole('option', { name: 'Apple Intelligence' });
    fireEvent.change(screen.getByLabelText('Use a model'), {
      target: { value: 'apple-foundation-models' },
    });
    await waitFor(() =>
      expect(f.service.setProvider).toHaveBeenCalledWith('apple-foundation-models'),
    );
    expect(f.service.store.writeConfig).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Import a model' })).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Import a model' }));
    await waitFor(() => expect(f.host.importModel).toHaveBeenCalledOnce());
    expect(f.service.withModelChange).toHaveBeenCalledOnce();
  });
  it('keeps download cancellation outside model admission and shows failures', async () => {
    const f = fixture();
    let finish!: () => void;
    f.host.prepareProvider.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    f.host.cancelProviderPreparation.mockRejectedValueOnce(new Error('Could not stop yet'));
    f.mount();
    await screen.findByRole('button', { name: 'Download Android on-device AI' });
    fireEvent.click(screen.getByRole('button', { name: 'Download Android on-device AI' }));
    const cancel = await screen.findByRole('button', { name: 'Cancel download' });
    fireEvent.click(cancel);
    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('Could not stop yet');
    expect(f.host.cancelProviderPreparation).toHaveBeenCalledWith('android-mlkit');
    expect(f.service.withModelChange).toHaveBeenCalledOnce();
    await act(async () => {
      finish();
    });
  });
});

describe('durable model conversation limits', () => {
  it('reads and merges the ordinary desktop fields under model admission', async () => {
    const f = fixture();
    const config = {
      provider: 'llama-cpp',
      modelContextOverrides: { 'llama-cpp:model-one': 2048, 'llama-cpp:other': 8192 },
      modelTuning: {
        'model-one': { sampling: { maxTokens: 256, temperature: 0.4 } },
        other: { sampling: { maxTokens: 512 } },
      },
    };
    f.service.store.readConfig.mockResolvedValue(config);
    const refresh = vi.fn(async () => {});
    const onError = vi.fn();
    render(
      <ModelBudgetSettings
        service={f.service as unknown as PortableProductService}
        provider={{ id: 'llama-cpp', contextTokens: 8192, maxOutputTokens: 4096 } as never}
        modelId="model-one"
        disabled={false}
        refresh={refresh}
        onError={onError}
      />,
    );
    const capacity = screen.getByLabelText('Conversation capacity (tokens)');
    const reply = screen.getByLabelText('Maximum reply (tokens)');
    await waitFor(() => expect(capacity).toHaveValue(2048));
    expect(reply).toHaveValue(256);
    fireEvent.change(capacity, { target: { value: '8192' } });
    fireEvent.change(reply, { target: { value: '2048' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save conversation limits' }));
    await screen.findByRole('status');
    expect(f.service.withModelChange).toHaveBeenCalledOnce();
    expect(f.service.store.writeConfig).toHaveBeenCalledExactlyOnceWith({
      modelContextOverrides: { 'llama-cpp:model-one': 8192, 'llama-cpp:other': 8192 },
      modelTuning: {
        'model-one': { sampling: { maxTokens: 2048, temperature: 0.4 } },
        other: { sampling: { maxTokens: 512 } },
      },
    });
    expect(onError).not.toHaveBeenCalled();
  });
  it('rejects a reply budget that leaves no conversation room without persisting it', async () => {
    const f = fixture();
    const onError = vi.fn();
    render(
      <ModelBudgetSettings
        service={f.service as unknown as PortableProductService}
        provider={{ id: 'llama-cpp', contextTokens: 8192, maxOutputTokens: 4096 } as never}
        modelId="model-one"
        disabled={false}
        refresh={vi.fn()}
        onError={onError}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Conversation capacity (tokens)')).toHaveValue(4096),
    );
    fireEvent.change(screen.getByLabelText('Maximum reply (tokens)'), {
      target: { value: '4096' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save conversation limits' }));
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(f.service.store.writeConfig).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
