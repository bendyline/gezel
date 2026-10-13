import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { onRadioKeyDown } from './radio-keyboard.js';

function Keys() {
  const [value, setValue] = useState('One');
  return (
    <>
      <div role="radiogroup" aria-label="Choices" onKeyDown={onRadioKeyDown}>
        {['One', 'Unavailable', 'Three'].map((item) => (
          <button
            key={item}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: exercises the button-shaped radio keys used by the app.
            role="radio"
            aria-checked={value === item}
            disabled={item === 'Unavailable'}
            tabIndex={value === item ? 0 : -1}
            onClick={() => setValue(item)}
          >
            {item}
          </button>
        ))}
      </div>
      <button type="button">After</button>
    </>
  );
}

describe('radio keys', () => {
  it('uses one tab stop, skips disabled choices, wraps, and supports Home and End', async () => {
    const user = userEvent.setup();
    render(<Keys />);
    await user.tab();
    expect(screen.getByRole('radio', { name: 'One' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    const three = screen.getByRole('radio', { name: 'Three' });
    expect(three).toHaveFocus();
    expect(three).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'One' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(three).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('radio', { name: 'One' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });
});
