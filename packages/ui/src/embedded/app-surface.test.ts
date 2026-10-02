import { APP_TOOL_SURFACE_HEADER } from '@bendyline/gezel';
import { describe, expect, it, vi } from 'vitest';
import { chatFrameUrl } from '../office/PaneApp.js';
import { readAppSurface, withAppSurface } from './app-surface.js';

describe('app surface', () => {
  it('reads the surface the Office pane frames its chat with', () => {
    const url = new URL(chatFrameUrl('p1', 'lead', 'pane-surface-1'), 'https://localhost');
    expect(readAppSurface(url.search)).toBe('pane-surface-1');
    expect(readAppSurface('?embedded=chat&projectId=p1')).toBeNull();
    expect(readAppSurface('?appSurface=no')).toBeNull();
  });

  it('stamps every request with the surface and keeps its other headers', async () => {
    const inner = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response());
    const stamped = withAppSurface(inner as unknown as typeof fetch, 'pane-surface-1');

    await stamped('https://localhost/api/sessions/s1/send', {
      method: 'POST',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
    });
    const headers = new Headers(inner.mock.calls[0]![1]?.headers);
    expect(headers.get(APP_TOOL_SURFACE_HEADER)).toBe('pane-surface-1');
    expect(headers.get('authorization')).toBe('Bearer t');
    expect(inner.mock.calls[0]![1]?.method).toBe('POST');

    await stamped(new Request('https://localhost/api/config', { headers: { Accept: 'x/y' } }));
    const fromRequest = new Headers(inner.mock.calls[1]![1]?.headers);
    expect(fromRequest.get(APP_TOOL_SURFACE_HEADER)).toBe('pane-surface-1');
    expect(fromRequest.get('accept')).toBe('x/y');
  });
});
