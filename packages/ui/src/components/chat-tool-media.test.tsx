import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { animatePicturePrefill, findPictureAnimator, isGeneratedPicture } = await import(
  './chat-tool-media.js'
);
const { api } = await import('../api.js');

describe('making a video from a generated picture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers it only for pictures an image gezel made', () => {
    expect(isGeneratedPicture('generated/image-2026-11-09T12-00-00-000Z-42.png')).toBe(true);
    expect(isGeneratedPicture('artifacts/generated/image-a.webp')).toBe(true);
    expect(isGeneratedPicture('screenshots/page.png')).toBe(false);
    expect(isGeneratedPicture('generated/video-a-poster.png')).toBe(false);
  });

  it('finds the video gezel only when an installed model can animate', async () => {
    vi.mocked(api.listGezels).mockResolvedValue({
      gezels: [
        { id: 'g1', name: 'Rembrandt', fixedFunction: { tool: 'generate_image' } },
        { id: 'g2', name: 'Vesna', fixedFunction: { tool: 'generate_video' } },
      ],
    } as never);
    vi.mocked(api.listInstalledVideoModels).mockResolvedValue({
      models: [],
      defaultImageToVideoModel: 'wan2.2-ti2v-5b-q4',
    } as never);
    expect(await findPictureAnimator()).toEqual({ id: 'g2', name: 'Vesna' });

    vi.mocked(api.listInstalledVideoModels).mockResolvedValue({ models: [] } as never);
    expect(await findPictureAnimator()).toBeNull();
  });

  it('hands the picture to the video gezel by mention', () => {
    expect(animatePicturePrefill({ id: 'g2', name: 'Vesna' }, 'generated/image-a.png')).toBe(
      '@[Vesna](gezel:g2) ![picture](artifacts/generated/image-a.png) ',
    );
  });
});
