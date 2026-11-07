import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PersonLabel } from './PersonLabel.js';

describe('PersonLabel', () => {
  it('writes an inline name and role as "name · role", nothing more', () => {
    const { container } = render(<PersonLabel name="Ada Lovelace" roleTitle="Engineer" />);
    const label = container.firstElementChild!;
    expect(label).toHaveClass('person-label', 'person-label--inline');
    expect(label).toHaveTextContent(/^Ada Lovelace · Engineer$/);
    expect(label.textContent).not.toMatch(/[()→-]/);
    expect(screen.getByText('Ada Lovelace')).toHaveClass('person-label-name');
    expect(screen.getByText('Engineer')).toHaveClass('person-label-role');
  });

  it('stacks the name above the role, with no separator', () => {
    const { container } = render(
      <PersonLabel
        variant="stacked"
        name="Ada Lovelace"
        roleTitle="Engineer"
        className="crew-row"
      />,
    );
    const label = container.firstElementChild!;
    expect(label).toHaveClass('person-label', 'person-label--stacked', 'crew-row');
    const text = label.querySelector('.person-label-text')!;
    expect(text.firstElementChild).toHaveTextContent(/^Ada Lovelace$/);
    expect(text.lastElementChild).toHaveClass('person-label-role');
    expect(text.lastElementChild).toHaveTextContent(/^Engineer$/);
    expect(label.querySelector('.person-label-sep')).toBeNull();
  });

  it('leaves out the dot and the role when there is no role', () => {
    const { container } = render(<PersonLabel name="Ada Lovelace" roleTitle="  " />);
    expect(container.firstElementChild).toHaveTextContent(/^Ada Lovelace$/);
    expect(container.querySelector('.person-label-sep, .person-label-role')).toBeNull();
  });

  it('keeps a badge with the name, before the role', () => {
    const { container } = render(
      <PersonLabel name="Bastien" roleTitle="Meester" badge={<span data-testid="hat" />} />,
    );
    const parts = [...container.firstElementChild!.children].map(
      (el) => el.getAttribute('data-testid') ?? el.className,
    );
    expect(parts).toEqual(['person-label-name', 'hat', 'person-label-sep', 'person-label-role']);
  });

  it('leads with the face, hidden from assistive tech since the name says who', () => {
    for (const variant of ['inline', 'stacked'] as const) {
      const { container, unmount } = render(
        <PersonLabel
          variant={variant}
          name="Ada Lovelace"
          roleTitle="Engineer"
          face={<span data-testid="face" />}
        />,
      );
      const face = container.querySelector('.person-label-face');
      expect(container.firstElementChild!.firstElementChild).toBe(face);
      expect(face).toHaveAttribute('aria-hidden', 'true');
      expect(face).toContainElement(screen.getByTestId('face'));
      unmount();
    }
  });

  it('renders no face slot without a face', () => {
    const { container } = render(<PersonLabel name="Ada Lovelace" face={false} />);
    expect(container.querySelector('.person-label-face')).toBeNull();
  });

  // The startup screen draws the Meester's caption with this component and
  // its script has a hard size budget, so neither core nor the API client
  // may ride in with it.
  it('imports nothing but React', () => {
    const source = readFileSync(resolve(import.meta.dirname, 'PersonLabel.tsx'), 'utf8');
    const modules = [...source.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(modules).toEqual(['react']);
  });
});
