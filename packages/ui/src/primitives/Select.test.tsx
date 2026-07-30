import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import * as Select from './Select.js';

describe('Select primitive', () => {
  it('uses the shared open-V dropdown chevron instead of a solid triangle', () => {
    render(
      <Select.Root>
        <Select.Trigger aria-label="Example choice">
          <Select.Value placeholder="Choose" />
        </Select.Trigger>
      </Select.Root>,
    );

    const trigger = screen.getByRole('combobox', { name: 'Example choice' });
    const chevron = trigger.querySelector('.gz-dropdown-chevron');

    expect(chevron).toHaveAttribute('fill', 'none');
    expect(chevron?.querySelector('path')).toHaveAttribute('stroke', 'currentColor');
    expect(chevron?.querySelector('polygon')).toBeNull();
  });
});
