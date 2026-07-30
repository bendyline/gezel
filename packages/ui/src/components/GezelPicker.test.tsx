import { type GezelSummary, initialPoppetjeForGezel } from '@bendyline/gezel';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GezelPicker } from './GezelPicker.js';

vi.mock('../api.js', () => ({
  api: {
    getConfig: vi.fn().mockResolvedValue({ showPoppetjes: true }),
  },
}));

const GEZELS = [
  {
    id: 'tomas',
    name: 'Tomas',
    role: 'Voorman',
    poppetje: initialPoppetjeForGezel('tomas', 'Tomas'),
  },
  {
    id: 'yusuf',
    name: 'Yusuf',
    role: 'Developer',
    poppetje: initialPoppetjeForGezel('yusuf', 'Yusuf'),
  },
] as GezelSummary[];

describe('GezelPicker', () => {
  beforeAll(() => {
    Object.defineProperties(HTMLElement.prototype, {
      hasPointerCapture: { configurable: true, value: () => false },
      setPointerCapture: { configurable: true, value: () => {} },
      releasePointerCapture: { configurable: true, value: () => {} },
      scrollIntoView: { configurable: true, value: () => {} },
    });
  });

  afterAll(() => {
    delete (HTMLElement.prototype as { hasPointerCapture?: unknown }).hasPointerCapture;
    delete (HTMLElement.prototype as { setPointerCapture?: unknown }).setPointerCapture;
    delete (HTMLElement.prototype as { releasePointerCapture?: unknown }).releasePointerCapture;
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('shows the selected poppetje and renders poppetjes for every menu option', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    const { container } = render(
      <GezelPicker
        gezels={GEZELS}
        value="tomas"
        noneLabel="(no voorman)"
        ariaLabel="Voorman"
        onValueChange={onValueChange}
      />,
    );

    const trigger = screen.getByRole('combobox', { name: 'Voorman' });
    expect(trigger).toHaveTextContent('Tomas');
    expect(trigger).toHaveTextContent('Voorman');
    expect(container.querySelector('.gezel-picker-trigger .gezel-icon-poppetje')).not.toBeNull();

    await user.click(trigger);

    const options = await screen.findAllByRole('option');
    expect(options).toHaveLength(3);
    expect(document.querySelectorAll('.gezel-picker-menu .gezel-icon-poppetje')).toHaveLength(2);

    await user.click(screen.getByRole('option', { name: /Yusuf.*Developer/ }));
    expect(onValueChange).toHaveBeenCalledWith('yusuf');
  });

  it('maps the empty choice to a null gezel id', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <GezelPicker
        gezels={GEZELS}
        value="tomas"
        noneLabel="(no voorman)"
        ariaLabel="Voorman"
        onValueChange={onValueChange}
      />,
    );

    await user.click(screen.getByRole('combobox', { name: 'Voorman' }));
    await user.click(await screen.findByRole('option', { name: '(no voorman)' }));

    expect(onValueChange).toHaveBeenCalledWith(null);
  });
});
