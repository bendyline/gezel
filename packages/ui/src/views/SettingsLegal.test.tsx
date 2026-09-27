import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { consumeOpenKnowledge } from '../components/pending-open-knowledge.js';
import { LEGAL_LINKS, PRIVACY_ARTICLE_ID, SettingsLegalSection } from './SettingsLegal.js';

describe('SettingsLegalSection', () => {
  afterEach(() => vi.restoreAllMocks());

  it('links the license, the third-party notices, and the EULA', () => {
    render(<SettingsLegalSection />);
    for (const label of ['License (MIT)', 'Third-party notices', 'End user license agreement']) {
      const link = screen.getByRole('link', { name: label });
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noreferrer');
    }
    expect(LEGAL_LINKS.map((link) => link.href)).toEqual([
      'https://github.com/bendyline/gezel/blob/main/LICENSE',
      'https://github.com/bendyline/gezel/blob/main/NOTICE.md',
      'https://github.com/bendyline/gezel/blob/main/packages/app/EULA.txt',
    ]);
  });

  it('opens the privacy article in the Handboek, inside the app', () => {
    const dispatched: string[] = [];
    vi.spyOn(window, 'dispatchEvent').mockImplementation((event) => {
      dispatched.push(event.type);
      return true;
    });
    render(<SettingsLegalSection />);
    fireEvent.click(screen.getByRole('button', { name: 'How Gezel handles your data' }));
    expect(consumeOpenKnowledge()).toMatchObject({
      catalogId: 'handboek',
      documentId: PRIVACY_ARTICLE_ID,
    });
    expect(dispatched).toEqual(['gezel:open-tab', 'gezel:open-knowledge-document']);
  });
});
