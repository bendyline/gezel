import { describe, expect, it } from 'vitest';
import { progressWriter } from './progress-output.js';

function capture(isTTY: boolean) {
  const written: string[] = [];
  return { isTTY, written, write: (text: string) => written.push(text) };
}

describe('progressWriter', () => {
  it('passes redraws through untouched on a terminal', () => {
    const stream = capture(true);
    const write = progressWriter(stream);
    write('\rdownloading:   1%');
    write('\rdownloading:   2%');

    expect(stream.written).toEqual(['\rdownloading:   1%', '\rdownloading:   2%']);
  });

  it('prints at most one update per interval in a log, plus every finished line', () => {
    let clock = 0;
    const stream = capture(false);
    const write = progressWriter(stream, { intervalMs: 1000, now: () => clock });

    write('\rdownloading:   1%');
    clock = 500;
    write('\rdownloading:  40%');
    clock = 1200;
    write('\rdownloading:  80%');
    clock = 1300;
    write(`\rdownloaded model${' '.repeat(48)}\n`);

    expect(stream.written).toEqual([
      'downloading:   1%\n',
      'downloading:  80%\n',
      'downloaded model\n',
    ]);
  });

  it('keeps retry notices and drops repeats and blank redraws', () => {
    const stream = capture(false);
    const write = progressWriter(stream, { intervalMs: 0 });

    write('\n  retry 1/5: Download stream failed\n');
    write('\n  retry 1/5: Download stream failed\n');
    write('\r   ');

    expect(stream.written).toEqual(['retry 1/5: Download stream failed\n']);
  });
});
