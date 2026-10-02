import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function directive(name: string): string[] {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const policy = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];
  if (!policy) throw new Error('index.html carries no Content-Security-Policy');
  const entry = policy
    .split(';')
    .map((part) => part.trim().split(/\s+/))
    .find(([key]) => key === name);
  return entry?.slice(1) ?? [];
}

describe('mobile Content-Security-Policy', () => {
  // The shared UI plays synthesized speech from data: URLs (voice preview,
  // chat narration) and recordings and videos from blob: URLs. Without its own
  // media-src the policy falls back to default-src 'self', which refuses both:
  // Kokoro synthesized the preview and the player silently failed to load it.
  it('lets the shared UI play data: and blob: media, as the desktop policy does', () => {
    expect(directive('media-src')).toEqual(expect.arrayContaining(["'self'", 'blob:', 'data:']));
  });
});
