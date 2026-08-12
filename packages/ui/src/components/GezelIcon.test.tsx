import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GezelIcon } from './GezelIcon.js';

vi.mock('./useShowPoppetjes.js', () => ({ useShowPoppetjes: () => true }));

describe('GezelIcon SVG isolation', () => {
  it('sanitizes a repository icon and renders it as an image, never live SVG DOM', () => {
    const { container } = render(
      <GezelIcon
        name="Portable"
        iconOverride
        svg={
          '<svg xmlns="http://www.w3.org/2000/svg" onload="steal()"><style>@import url(https://attacker.test/x)</style><foreignObject><iframe src="https://attacker.test/frame"/></foreignObject><path d="M0 0h2v2z" onclick="steal()"/></svg>'
        }
      />,
    );

    const image = container.querySelector('img.gezel-icon-svg');
    expect(image).not.toBeNull();
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('script, style, foreignObject, iframe')).toBeNull();
    const isolatedSvg = decodeURIComponent(image!.getAttribute('src')!.split(',')[1]!);
    expect(isolatedSvg).toContain('<path d="M0 0h2v2z"/>');
    expect(isolatedSvg).not.toContain('onload');
    expect(isolatedSvg).not.toContain('onclick');
    expect(isolatedSvg).not.toContain('attacker.test');
  });

  it('uses the letter fallback when no allowed geometry survives', () => {
    const { container } = render(
      <GezelIcon
        name="Portable"
        iconOverride
        svg={'<svg xmlns="http://www.w3.org/2000/svg"><script>only content</script></svg>'}
      />,
    );
    expect(container.querySelector('img, svg')).toBeNull();
    expect(screen.getByText('P')).toBeVisible();
  });
});
