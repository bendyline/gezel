import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

it('loads native verification without loading the daemon dependency graph', async () => {
  // A fresh loader catches transitive imports too, without Vitest's module cache
  // or mocks hiding an accidental dependency on the service's main entry point.
  const entry = new URL('./native-verification-entry.ts', import.meta.url).href;
  const serviceRoot = new URL('../', import.meta.url).href;
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import { registerHooks } from 'node:module';
        const entry = ${JSON.stringify(entry)};
        const serviceRoot = ${JSON.stringify(serviceRoot)};
        registerHooks({
          load(url, context, nextLoad) {
            if (url.startsWith(serviceRoot) && !url.includes('/node_modules/') && url !== entry) {
              throw new Error('Native verification loaded daemon code: ' + url);
            }
            return nextLoad(url, context);
          },
        });
        const verification = await import(entry);
        console.log(JSON.stringify({
          verify: typeof verification.verifyNativeBinaries,
          reuse: typeof verification.reuseVerifiedElectronNativeBinaries,
        }));
      `,
    ],
    { timeout: 15_000, windowsHide: true },
  );
  expect(JSON.parse(stdout)).toEqual({ verify: 'function', reuse: 'function' });
});
