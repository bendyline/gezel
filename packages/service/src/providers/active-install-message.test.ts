import { describe, expect, it } from 'vitest';
import {
  type ActiveInstallLike,
  installPercent,
  noModelYetMessage,
} from './active-install-message.js';

const downloading = (bytesWritten: number, totalBytes: number): ActiveInstallLike => ({
  catalogId: 'gemma4-e4b-q4',
  bytesWritten,
  totalBytes,
  phase: 'downloading',
});

describe('installPercent', () => {
  it('floors to a whole percent', () => {
    expect(installPercent(downloading(43_900, 100_000))).toBe(43);
  });

  it('never reports 100 while bytes are still arriving', () => {
    // "100% downloaded" beside a turn that just failed reads as a lie.
    expect(installPercent(downloading(99_999, 100_000))).toBe(99);
  });

  it('returns null when the total size is unknown', () => {
    expect(installPercent(downloading(5, 0))).toBeNull();
    expect(installPercent(downloading(5, Number.NaN))).toBeNull();
  });
});

describe('noModelYetMessage', () => {
  it('tells the truth about an in-flight download instead of demanding one', () => {
    const message = noModelYetMessage('Local model', downloading(43_000, 100_000));
    expect(message).toContain('43% downloaded');
    expect(message).toContain('hang tight');
    // The old copy pointed at a Settings list that is not on screen in chat.
    expect(message).not.toContain('list above');
  });

  it('degrades to a plain wait when the size is unknown', () => {
    expect(noModelYetMessage('Local model', downloading(1, 0))).toContain('still downloading');
  });

  it('names the post-download phases rather than claiming a download', () => {
    expect(noModelYetMessage('Apple MLX', { ...downloading(1, 2), phase: 'verifying' })).toContain(
      'being verified',
    );
    expect(
      noModelYetMessage('Apple MLX', { ...downloading(1, 2), phase: 'extracting-metadata' }),
    ).toContain('being prepared');
  });

  it('points at Settings only when nothing is actually running', () => {
    const message = noModelYetMessage('Local model', null);
    expect(message).toContain('Settings → Artificial Intelligence');
    expect(message).not.toContain('hang tight');
  });
});
