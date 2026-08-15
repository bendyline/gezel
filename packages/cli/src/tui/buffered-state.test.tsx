import { PassThrough } from 'node:stream';
import { Text, render } from 'ink';
import { type ReactNode, act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BufferedStateSetter, useBufferedState } from './buffered-state.js';

type Harness = ReturnType<typeof renderHarness>;
const mounted: Harness[] = [];

afterEach(async () => {
  for (const harness of mounted.splice(0)) {
    const exit = harness.waitUntilExit();
    harness.unmount();
    await exit;
  }
});

describe('useBufferedState', () => {
  it('reduces every streamed update while publishing at most once per interval', async () => {
    let setImmediate: BufferedStateSetter<number> | undefined;
    let setBuffered: BufferedStateSetter<number> | undefined;
    const rendered: number[] = [];
    const harness = renderHarness(
      <Probe
        intervalMs={30}
        capture={(immediate, buffered) => {
          setImmediate = immediate;
          setBuffered = buffered;
        }}
        onRender={(value) => rendered.push(value)}
      />,
    );
    mounted.push(harness);

    await vi.waitFor(() => expect(rendered.at(-1)).toBe(0));
    act(() => {
      setBuffered?.((value) => value + 1);
      setBuffered?.((value) => value + 1);
      setBuffered?.((value) => value + 1);
    });

    expect(rendered.at(-1)).toBe(0);
    await vi.waitFor(() => expect(rendered.at(-1)).toBe(3));

    act(() => {
      setBuffered?.((value) => value + 1);
      setImmediate?.((value) => value + 1);
    });
    await harness.waitUntilRenderFlush();
    expect(rendered.at(-1)).toBe(5);
  });

  it('cancels a pending buffered publish when the component unmounts', async () => {
    let setBuffered: BufferedStateSetter<number> | undefined;
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const harness = renderHarness(
      <Probe
        intervalMs={30}
        capture={(_immediate, buffered) => {
          setBuffered = buffered;
        }}
        onRender={() => {}}
      />,
    );

    await vi.waitFor(() => expect(setBuffered).toBeTypeOf('function'));
    await harness.waitUntilRenderFlush();
    act(() => setBuffered?.(1));
    const exit = harness.waitUntilExit();
    harness.unmount();
    await exit;

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});

function Probe({
  intervalMs,
  capture,
  onRender,
}: {
  intervalMs: number;
  capture: (
    setImmediate: BufferedStateSetter<number>,
    setBuffered: BufferedStateSetter<number>,
  ) => void;
  onRender: (value: number) => void;
}) {
  const [value, setImmediate, setBuffered] = useBufferedState(0, intervalMs);
  capture(setImmediate, setBuffered);
  onRender(value);
  return <Text>value={value}</Text>;
}

type TestOutput = PassThrough &
  NodeJS.WriteStream & {
    isTTY: true;
    columns: number;
    rows: number;
  };

function renderHarness(node: ReactNode) {
  const stdout = new PassThrough() as TestOutput;
  Object.defineProperties(stdout, {
    isTTY: { value: true },
    columns: { value: 100, writable: true },
    rows: { value: 30, writable: true },
  });
  return render(node, {
    stdout,
    debug: true,
    interactive: false,
    patchConsole: false,
    maxFps: 1_000,
  });
}
