import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { takePendingSettingsSection } from '../settings-nav.js';
import { WarningBanner } from './chat-bubbles.js';

describe('WarningBanner', () => {
  beforeEach(() => {
    takePendingSettingsSection();
  });

  it('links an actionable model update warning to its local-engine settings page', () => {
    let navigation: { view?: string; section?: string } | undefined;
    const onNavigate = (event: Event) => {
      navigation = (event as CustomEvent<{ view?: string; section?: string }>).detail;
    };
    window.addEventListener('gezel:navigate', onNavigate);

    const { container } = render(
      <WarningBanner
        warnings={[
          {
            type: 'warning',
            message:
              "Updates are available for the 'qwen3.6-27b-q8' model. You can download a new model in Settings.",
            action: { kind: 'settings', section: 'mlx' },
          },
        ]}
      />,
    );

    expect(container.querySelector('.msg-warning-banner')).toHaveTextContent(
      "Updates are available for the 'qwen3.6-27b-q8' model. You can download a new model in Settings.",
    );
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    expect(takePendingSettingsSection()).toBe('mlx');
    expect(navigation).toEqual({ view: 'settings', section: 'mlx' });
    window.removeEventListener('gezel:navigate', onNavigate);
  });

  it('keeps ordinary string warnings as plain text and deduplicates them', () => {
    render(<WarningBanner warnings={['Provider is busy.', 'Provider is busy.']} />);

    expect(screen.getAllByText(/Provider is busy/)).toHaveLength(1);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
