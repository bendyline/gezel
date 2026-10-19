import { parseImageSettingsFromText } from '@bendyline/gezel';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ComposerImageSettingsBar } from './ComposerImageSettingsBar.js';
import type { ComposerImageSettings } from './useComposerImageSettings.js';

const flux = {
  id: 'flux-2-klein-4b-q4',
  name: 'FLUX.2 Klein',
  approxSizeBytes: 1,
  installedAt: '2026-10-19T00:00:00Z',
  kind: 'local' as const,
  defaultSidePx: 1024,
};

function settings(overrides: Partial<ComposerImageSettings> = {}): ComposerImageSettings {
  return {
    enabled: true,
    picks: {},
    cues: null,
    effective: {},
    model: flux,
    models: [flux],
    highRefusal: null,
    pick: vi.fn(),
    dismissCues: vi.fn(),
    sendFields: () => ({}),
    ...overrides,
  };
}

describe('ComposerImageSettingsBar', () => {
  it('latches square by default and reads out the default render', () => {
    render(<ComposerImageSettingsBar settings={settings()} />);
    expect(screen.getByRole('radio', { name: /^1:1/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/1:1 · 1024×1024 · FLUX\.2 Klein · default/)).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Image settings' })).toHaveAttribute(
      'data-origin',
      'user',
    );
  });

  it('picks a shape and a size', () => {
    const s = settings();
    render(<ComposerImageSettingsBar settings={s} />);
    fireEvent.click(screen.getByRole('radio', { name: /^9:16/ }));
    expect(s.pick).toHaveBeenCalledWith({ aspectRatio: '9:16' });
    fireEvent.click(screen.getByRole('radio', { name: 'Draft' }));
    expect(s.pick).toHaveBeenCalledWith({ quality: 'draft' });
  });

  it('draws the strip dashed while the message names the shape, with a way to send it as typed', () => {
    const cues = parseImageSettingsFromText('a fox as a phone wallpaper');
    const s = settings({ cues, effective: cues.settings });
    render(<ComposerImageSettingsBar settings={s} />);
    expect(screen.getByRole('group', { name: 'Image settings' })).toHaveAttribute(
      'data-origin',
      'suggested',
    );
    expect(screen.getByText('From your message')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^9:16/ })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Use as typed' }));
    expect(s.dismissCues).toHaveBeenCalled();
  });

  it('holds High back with the reason when it will not fit', () => {
    render(
      <ComposerImageSettingsBar
        settings={settings({ highRefusal: 'Needs 24 GB; this computer has 16 GB.' })}
      />,
    );
    const high = screen.getByRole('radio', { name: 'High' });
    expect(high).toBeDisabled();
    expect(high).toHaveAttribute('title', 'Needs 24 GB; this computer has 16 GB.');
  });
});
