import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RecommendedBadge } from './RecommendedBadge.js';

describe('RecommendedBadge', () => {
  it('shows for an open model that carries a recoScore', () => {
    render(<RecommendedBadge manifest={{ recoScore: 20, licenseClass: 'open' }} />);
    expect(screen.getByText(/Recommended/)).toBeInTheDocument();
  });

  it('hides when there is no recoScore (not a recommended model)', () => {
    const { container } = render(<RecommendedBadge manifest={{ licenseClass: 'open' }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('hides for a non-open license even with a score (the safety gate)', () => {
    const { container } = render(
      <RecommendedBadge manifest={{ recoScore: 99, licenseClass: 'custom-restricted' }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('hides for a model that cannot call tools, however high the score', () => {
    const { container } = render(
      <RecommendedBadge manifest={{ recoScore: 99, licenseClass: 'open', supportsTools: false }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('still shows for media manifests, which declare no supportsTools at all', () => {
    render(<RecommendedBadge manifest={{ recoScore: 10, licenseClass: 'open' }} />);
    expect(screen.getByText(/Recommended/)).toBeInTheDocument();
  });
});
