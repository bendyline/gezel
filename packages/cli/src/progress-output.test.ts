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

  it('prints a download as one line per step and a few percentages in a log', () => {
    const stream = capture(false);
    const write = progressWriter(stream);

    // What `gezel --download run` sent through it, one update per chunk.
    for (let kib = 0; kib <= 230 * 1024; kib += 128) {
      const pct = Math.floor((kib / (230 * 1024)) * 100);
      write(`\rllama-server: ${String(pct).padStart(3)}%  ${kib} KiB/230.4 MiB`);
    }
    write('\n');
    write('llama-server: verifying archive\n');
    write('llama-server: ready — C:\\gezel\\bin\\llama-server.exe\n');
    for (let pct = 0; pct <= 100; pct++) {
      write(`\rdownloading qwen3.5-2b-q4 (llama-cpp): ${String(pct).padStart(3)}%  1.33 GB`);
    }
    write(`\rdownloaded qwen3.5-2b-q4 (llama-cpp)${' '.repeat(48)}\n`);

    expect(stream.written).toEqual([
      'llama-server:   0%  0 KiB/230.4 MiB\n',
      'llama-server:  25%  58880 KiB/230.4 MiB\n',
      'llama-server:  50%  117760 KiB/230.4 MiB\n',
      'llama-server:  75%  176640 KiB/230.4 MiB\n',
      'llama-server: verifying archive\n',
      'llama-server: ready — C:\\gezel\\bin\\llama-server.exe\n',
      'downloading qwen3.5-2b-q4 (llama-cpp):   0%  1.33 GB\n',
      'downloading qwen3.5-2b-q4 (llama-cpp):  25%  1.33 GB\n',
      'downloading qwen3.5-2b-q4 (llama-cpp):  50%  1.33 GB\n',
      'downloading qwen3.5-2b-q4 (llama-cpp):  75%  1.33 GB\n',
      'downloaded qwen3.5-2b-q4 (llama-cpp)\n',
    ]);
    expect(stream.written.join('')).not.toContain('\r');
  });

  it('prints an update without a percentage at most once per interval', () => {
    let clock = 0;
    const stream = capture(false);
    const write = progressWriter(stream, { intervalMs: 1000, now: () => clock });

    write('\rpreparing the runtime: 0m 00s');
    clock = 500;
    write('\rpreparing the runtime: 0m 01s');
    clock = 1200;
    write('\rpreparing the runtime: 0m 02s');
    clock = 1300;
    write(`\rruntime ready${' '.repeat(48)}\n`);

    expect(stream.written).toEqual([
      'preparing the runtime: 0m 00s\n',
      'preparing the runtime: 0m 02s\n',
      'runtime ready\n',
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
