import { describe, expect, it } from 'vitest';
import { formatMediaClock, mediaSpanLabel } from './media-label.js';

describe('media labels', () => {
  it('formats a moment as m:ss, or h:mm:ss past an hour', () => {
    expect(formatMediaClock(0)).toBe('0:00');
    expect(formatMediaClock(95_500)).toBe('1:35');
    expect(formatMediaClock(3_725_000)).toBe('1:02:05');
  });

  it('names the kind and, for video and sound, the matched span', () => {
    expect(mediaSpanLabel({ modality: 'image' })).toBe('Photo');
    expect(mediaSpanLabel({ modality: 'video', startMs: 90_000, endMs: 120_000 })).toBe(
      'Video · 1:30–2:00',
    );
    expect(mediaSpanLabel({ modality: 'audio', startMs: 0 })).toBe('Sound · 0:00');
  });
});
