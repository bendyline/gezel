// @vitest-environment jsdom
import { OFFLINE_RUNTIME_CAPABILITIES } from '@bendyline/gezel';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);
vi.mock('./AudioEngineSettings.js', () => ({ AudioEngineSettings: () => null }));

const { HostModelSettings } = await import('./HostModelSettings.js');

describe('phone Settings', () => {
  const bridge = window.__GEZEL__;
  beforeEach(() => {
    window.__GEZEL__ = {
      token: 'test',
      platform: 'mobile',
      capabilities: OFFLINE_RUNTIME_CAPABILITIES,
      renderModelSettings: () => <p>models</p>,
    };
  });
  afterEach(() => {
    window.__GEZEL__ = bridge;
  });

  it('reaches every section from one dropdown, About included', async () => {
    render(<HostModelSettings />);
    const picker = screen.getByTestId('mock-select') as HTMLSelectElement;
    expect([...picker.options].map((option) => option.textContent)).toEqual([
      'Artificial Intelligence',
      'General',
      'Backup and restore',
      'About',
    ]);
    fireEvent.change(picker, { target: { value: 'about' } });
    expect(await screen.findByText('test')).toBeTruthy();
    expect(screen.getByText('Third-party notices')).toBeTruthy();
    // The phone has no Handboek to open.
    expect(screen.queryByText('How Gezel handles your data')).toBeNull();
  });

  it('marks the sidebar position so a compact layout can hide it', () => {
    render(<HostModelSettings />);
    fireEvent.change(screen.getByTestId('mock-select'), { target: { value: 'general' } });
    expect(screen.getByText('Sidebar position').closest('section')?.className).toBe(
      'settings-sidebar-side',
    );
  });
});
