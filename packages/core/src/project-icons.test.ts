import { describe, expect, it } from 'vitest';
import {
  ProjectCustomIconSchema,
  ProjectIconIdSchema,
  projectTypeIcon,
  resolveProjectIcon,
  sniffProjectIconImage,
} from './project-icons.js';

describe('project maker marks', () => {
  it('uses explicit type marks before deterministic inference', () => {
    expect(projectTypeIcon({ id: 'web-app', icon: 'palette', category: 'code' })).toBe('palette');
    expect(projectTypeIcon({ id: 'web-app' })).toBe('code');
    expect(projectTypeIcon({ id: 'community-api-kit', tags: ['backend'], category: 'other' })).toBe(
      'server',
    );
    expect(projectTypeIcon({ id: 'unknown-kit', category: 'writing' })).toBe('quill');
  });

  it('keeps the vocabulary finite and schema-safe', () => {
    expect(ProjectIconIdSchema.parse('code')).toBe('code');
    expect(() => ProjectIconIdSchema.parse('arbitrary-emoji')).toThrow();
  });

  it('resolves project inheritance in one stable order', () => {
    expect(
      resolveProjectIcon({
        icon: 'heart',
        projectType: { id: 'web-app', icon: 'code' },
        projectTypeId: 'email',
      }),
    ).toBe('heart');
    expect(resolveProjectIcon({ projectType: { id: 'custom', icon: 'palette' } })).toBe('palette');
    expect(resolveProjectIcon({ projectTypeId: 'api-service' })).toBe('server');
    expect(resolveProjectIcon({ detectedProjectType: { id: 'content-writing' } })).toBe('quill');
    expect(resolveProjectIcon({ github: { url: 'https://github.com/o/r' } })).toBe('branch');
    expect(resolveProjectIcon({ workingDir: '/work/repo' })).toBe('folder');
    expect(resolveProjectIcon({})).toBe('sheet');
  });
});

describe("a project's own icon art", () => {
  it('reads a picture format from its bytes, and nothing else', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0, 0]);
    const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 9, 9, 9, 9, 0x57, 0x45, 0x42, 0x50]);
    expect(sniffProjectIconImage(png)).toBe('png');
    expect(sniffProjectIconImage(jpeg)).toBe('jpeg');
    expect(sniffProjectIconImage(webp)).toBe('webp');
    // A RIFF file that is not WebP (a WAV), an SVG, a GIF and a short read.
    expect(
      sniffProjectIconImage(
        Uint8Array.from([0x52, 0x49, 0x46, 0x46, 9, 9, 9, 9, 0x57, 0x41, 0x56, 0x45]),
      ),
    ).toBeNull();
    expect(sniffProjectIconImage(new TextEncoder().encode('<svg xmlns="x"/>'))).toBeNull();
    expect(sniffProjectIconImage(new TextEncoder().encode('GIF89a'))).toBeNull();
    expect(sniffProjectIconImage(Uint8Array.from([0x89, 0x50]))).toBeNull();
    expect(sniffProjectIconImage(new Uint8Array())).toBeNull();
  });

  it('records what kind of art it is and when it changed', () => {
    expect(
      ProjectCustomIconSchema.parse({ kind: 'drawn', format: 'svg', updatedAt: '2026-11-12' }),
    ).toEqual({ kind: 'drawn', format: 'svg', updatedAt: '2026-11-12' });
    expect(ProjectCustomIconSchema.safeParse({ kind: 'image', format: 'gif' }).success).toBe(false);
  });
});
