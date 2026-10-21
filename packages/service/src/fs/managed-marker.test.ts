import { describe, expect, it } from 'vitest';
import { createManagedMarker } from './managed-marker.js';

const marker = createManagedMarker({ commentPrefix: '# ', noun: 'profile' });

describe('createManagedMarker', () => {
  it('names the current Settings page in what it writes', () => {
    expect(marker.build('body\n', 'owner-a').split('\n')[0]).toBe(
      '# Managed by Gezel. Use Settings > Integrations to change or remove this profile.',
    );
  });

  it('still recognizes a file written before the page was renamed', () => {
    const current = marker.build('body\n', 'owner-a');
    const legacy = current.replace('Settings > Integrations', 'Settings > Connected Apps');
    expect(marker.isManaged(legacy, 'owner-a')).toBe(true);
    expect(marker.isClaimed(legacy)).toBe(true);
    expect(marker.isManaged(legacy, 'owner-b')).toBe(false);
  });

  it('treats a hand edit or an unrelated file as not ours', () => {
    const edited = `${marker.build('body\n', 'owner-a')}extra\n`;
    expect(marker.isManaged(edited, 'owner-a')).toBe(false);
    expect(marker.isClaimed(edited)).toBe(true);
    expect(marker.isClaimed('model = "gpt"\n')).toBe(false);
  });
});
