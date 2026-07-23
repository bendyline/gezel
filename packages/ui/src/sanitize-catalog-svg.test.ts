import { describe, expect, it } from 'vitest';
import { sanitizeCatalogSvg } from './sanitize-catalog-svg.js';

describe('sanitizeCatalogSvg', () => {
  it('preserves presentation geometry', () => {
    const safe = sanitizeCatalogSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0" stroke="currentColor"/></svg>',
    );
    expect(safe).toContain('<path');
    expect(safe).toContain('viewBox="0 0 24 24"');
  });

  it('removes active content and external resource references', () => {
    const safe = sanitizeCatalogSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="steal()"><script>steal()</script><foreignObject><iframe src="https://evil.example"/></foreignObject><path style="fill:url(https://evil.example/x)" d="M0 0"/></svg>',
    );
    expect(safe).not.toContain('onload');
    expect(safe).not.toContain('script');
    expect(safe).not.toContain('foreignObject');
    expect(safe).not.toContain('iframe');
    expect(safe).not.toContain('evil.example');
  });
});
