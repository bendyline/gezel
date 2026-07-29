import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = {
  getConfig: vi.fn(),
  updateConfig: vi.fn(),
};

vi.mock('../../api.js', () => ({ api: apiMock }));

const {
  DEFAULT_OPTIONS,
  loadLastExportOptions,
  normalizeExportOptions,
  saveExportOptions,
  syncLastExportOptions,
} = await import('./export-options.js');

describe('document export option persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    apiMock.getConfig.mockReset();
    apiMock.updateConfig.mockReset();
    apiMock.updateConfig.mockResolvedValue({});
  });

  it('rejects malformed cached values instead of creating a broken quick action', () => {
    localStorage.setItem(
      'gezel-export-options',
      JSON.stringify({ ...DEFAULT_OPTIONS, format: 'pages' }),
    );
    expect(loadLastExportOptions()).toBeNull();
    expect(normalizeExportOptions({ format: 'pdf', pageSize: 'tabloid' })).toBeNull();
  });

  it('uses the durable config preference and primes the current-origin cache', async () => {
    const durable = {
      ...DEFAULT_OPTIONS,
      format: 'docx' as const,
      themeId: 'gezellig',
      pageSize: 'a4' as const,
    };
    localStorage.setItem(
      'gezel-export-options',
      JSON.stringify({ ...DEFAULT_OPTIONS, format: 'pdf' }),
    );
    apiMock.getConfig.mockResolvedValue({ documentExportOptions: durable });

    await expect(syncLastExportOptions()).resolves.toEqual(durable);
    expect(loadLastExportOptions()).toEqual(durable);
  });

  it('writes both the immediate cache and the cross-boot config field', async () => {
    const options = { ...DEFAULT_OPTIONS, format: 'pptx' as const };
    await saveExportOptions(options);

    expect(loadLastExportOptions()).toEqual(options);
    expect(apiMock.updateConfig).toHaveBeenCalledWith({ documentExportOptions: options });
  });
});
