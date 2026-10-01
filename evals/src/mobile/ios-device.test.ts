import { describe, expect, it } from 'vitest';
import { iosContainerCopyArgs } from './ios-device.ts';

describe('devicectl container copies', () => {
  it('reads from the app container into a local file', () => {
    const argv = iosContainerCopyArgs('from', 'UDID', '/tmp/report.json', 'Documents/r.json');
    expect(argv.slice(0, 4)).toEqual(['devicectl', 'device', 'copy', 'from']);
    expect(argv[argv.indexOf('--source') + 1]).toBe('Documents/r.json');
    expect(argv[argv.indexOf('--destination') + 1]).toBe('/tmp/report.json');
    expect(argv[argv.indexOf('--domain-identifier') + 1]).toBe('com.bendyline.gezel.mobile');
  });

  it('writes a local file into the app container', () => {
    const argv = iosContainerCopyArgs('to', 'UDID', '/models/m.gguf', 'Library/Caches/m.gguf');
    expect(argv[3]).toBe('to');
    expect(argv[argv.indexOf('--source') + 1]).toBe('/models/m.gguf');
    expect(argv[argv.indexOf('--destination') + 1]).toBe('Library/Caches/m.gguf');
    expect(argv[argv.indexOf('--device') + 1]).toBe('UDID');
  });
});
