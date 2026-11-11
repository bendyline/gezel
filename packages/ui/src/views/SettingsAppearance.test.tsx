import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { SidebarSidePicker } = await import('./SettingsAppearance.js');
const { syncSidebarSideFromConfig } = await import('../sidebar-side.js');
const { api } = await import('../api.js');

const pressed = (name: string) =>
  screen.getByRole('button', { name }).getAttribute('aria-pressed') === 'true';
const stamped = () => document.documentElement.getAttribute('data-sidebar-side');

describe('the sidebar position keys', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-sidebar-side');
    vi.mocked(api.updateConfig).mockResolvedValue({} as never);
  });

  // The desktop app opens on a fresh origin with an empty cache, so the side
  // a person chose arrives with the config, after Settings may have drawn.
  it('follow the side the boot-time sync settles', async () => {
    render(<SidebarSidePicker />);
    expect(pressed('Left')).toBe(true);

    vi.mocked(api.getConfig).mockResolvedValue({ sidebarSide: 'right' } as never);
    await act(() => syncSidebarSideFromConfig());
    expect(pressed('Right')).toBe(true);
    expect(pressed('Left')).toBe(false);
    expect(stamped()).toBe('right');
  });

  it('move the rail and save the choice by name', () => {
    render(<SidebarSidePicker />);
    fireEvent.click(screen.getByRole('button', { name: 'Right' }));
    expect(pressed('Right')).toBe(true);
    expect(stamped()).toBe('right');
    expect(api.updateConfig).toHaveBeenLastCalledWith({ sidebarSide: 'right' });

    fireEvent.click(screen.getByRole('button', { name: 'Left' }));
    expect(pressed('Left')).toBe(true);
    expect(stamped()).toBeNull();
    expect(api.updateConfig).toHaveBeenLastCalledWith({ sidebarSide: 'left' });
  });
});
