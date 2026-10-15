import type { PortableProductService } from '@bendyline/gezel/runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RemoteModelSettings } from './RemoteModelSettings.js';

const render = (available: boolean) =>
  renderToStaticMarkup(
    <RemoteModelSettings
      service={{ remotes: { available } } as unknown as PortableProductService}
      disabled={false}
      onChanged={async () => {}}
      useLocal={async () => {}}
      onError={() => {}}
    />,
  );

describe('another device’s models on a phone', () => {
  it('is offered only where the app can reach other devices', () => {
    expect(render(false)).toBe('');
  });

  it('explains the fallback and offers connecting by address', () => {
    const html = render(true);
    expect(html).toContain('Another device');
    expect(html).toContain('This phone&#x27;s own model answers while you&#x27;re away from it.');
    expect(html).toContain('Connect by address');
  });
});
