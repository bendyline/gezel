import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { androidShellCommand } from './android-runner.ts';
import { runMobileFeedbackPump } from './feedback.ts';
import { writeNativeReceipt } from './receipt-transport.ts';
import type { MobileReport } from './report.ts';

const exec = promisify(execFile);
/** The only bridge is app-private files read by opt-in native test code. */
export async function withNativeFeedback<T>(
  options: {
    platform: 'android' | 'ios';
    device: string;
    runId: string;
    output: string;
    adb?: string;
    log: (line: string) => void;
  },
  run: () => Promise<T>,
): Promise<T> {
  const abort = new AbortController();
  let iosContainer: string | undefined;
  let receiptNumber = 0;
  const relative = `files/mobile-evals/${options.runId}.json`;
  const pump = runMobileFeedbackPump({
    signal: abort.signal,
    log: options.log,
    read: async () => {
      try {
        if (options.platform === 'android') {
          const result = await exec(
            options.adb!,
            [
              '-s',
              options.device,
              'exec-out',
              androidShellCommand(['run-as', 'com.bendyline.gezel.mobile', 'cat', relative]),
            ],
            { maxBuffer: 64 * 1024 * 1024, timeout: 10000, signal: abort.signal },
          );
          return JSON.parse(result.stdout) as MobileReport;
        }
        iosContainer ??= (
          await exec(
            'xcrun',
            ['simctl', 'get_app_container', options.device, 'com.bendyline.gezel.mobile', 'data'],
            { timeout: 10000, signal: abort.signal },
          )
        ).stdout.trim();
        return JSON.parse(
          await readFile(
            join(iosContainer, 'Documents/mobile-evals', `${options.runId}.json`),
            'utf8',
          ),
        ) as MobileReport;
      } catch {
        // Xcode can replace the simulator data container while installing the test host.
        iosContainer = undefined;
        return null;
      } // Build/startup/atomic snapshot replacement can precede the first report.
    },
    write: async (receipt) => {
      const encoded = JSON.stringify(receipt);
      const directory = join(options.output, 'grading-receipts');
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, `${String(receiptNumber++).padStart(4, '0')}.json`),
        `${encoded}\n`,
      );
      if (options.platform === 'ios') {
        if (!iosContainer) throw new Error('iOS test container has not been discovered');
        const path = join(
          iosContainer,
          'Documents/mobile-evals',
          `${options.runId}.json.receipt.json`,
        );
        await writeFile(`${path}.tmp`, encoded);
        await rename(`${path}.tmp`, path);
        return;
      }
      const path = `${relative}.receipt.json`;
      await writeNativeReceipt(
        options.adb!,
        [
          '-s',
          options.device,
          'shell',
          '-T',
          androidShellCommand([
            'run-as',
            'com.bendyline.gezel.mobile',
            'sh',
            '-c',
            `cat > '${path}.tmp' && mv '${path}.tmp' '${path}'`,
          ]),
        ],
        encoded,
        { signal: abort.signal },
      );
    },
  });
  try {
    return await run();
  } finally {
    abort.abort();
    await pump;
  }
}
