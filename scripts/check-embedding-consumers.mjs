/** Real packed SDKs in an empty consumer. Never installs into this workspace. */
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withDependencyReadLease } from './dependency-lease.mjs';
import { spawnPnpm } from './pnpm-cli.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = new Set(process.argv.slice(2));
for (const flag of flags)
  if (!['--keep', '--offline', '--native-ios', '--native-android'].includes(flag))
    throw new Error(`Unknown option: ${flag}`);
const native = flags.has('--native-ios') || flags.has('--native-android');
const consumer = await mkdtemp(path.join(tmpdir(), 'gezel-embedding-consumer-'));
const env = {
  ...process.env,
  GEZEL_HOME: path.join(consumer, 'unrelated-home'),
  GEZEL_SYSTEM_SERVICE_HOME: path.join(consumer, 'system'),
  GEZEL_MACHINE_SHARED_HOME: path.join(consumer, 'machine'),
};
async function finish(child) {
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Consumer command failed: ${code}`)),
    );
  });
}
async function run(command, args, cwd = consumer) {
  await finish(
    spawn(command, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' }),
  );
}
try {
  await withDependencyReadLease(
    root,
    async ({ leaseEnv }) => {
      Object.assign(env, leaseEnv);
      const packs = path.join(consumer, 'tarballs');
      await mkdir(packs);
      for (const name of ['gezk', 'gezel', 'gezel-client', 'gezel-app-sdk', 'gezel-capacitor']) {
        await finish(
          spawnPnpm(['--filter', `@bendyline/${name}`, 'pack', '--pack-destination', packs], {
            cwd: root,
            env,
            stdio: 'inherit',
          }),
        );
      }
      const dependencies = {};
      for (const file of await readdir(packs)) {
        if (!file.endsWith('.tgz')) continue;
        const name = file.replace(/^bendyline-/, '').replace(/-\d+\.\d+\.\d+.*\.tgz$/, '');
        dependencies[`@bendyline/${name}`] = `file:./tarballs/${file}`;
      }
      dependencies['@capacitor/core'] = '8.5.2';
      if (native)
        for (const name of ['cli', 'ios', 'android']) dependencies[`@capacitor/${name}`] = '8.5.2';
      await writeFile(
        path.join(consumer, 'package.json'),
        JSON.stringify(
          {
            name: 'gezel-external-embedding-fixture',
            version: '1.0.0',
            private: true,
            type: 'module',
            dependencies,
          },
          null,
          2,
        ),
      );
      await run('npm', [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--omit=optional',
        ...(flags.has('--offline') ? ['--offline'] : []),
      ]);
      await cp(path.join(root, 'tests/embedding-consumers'), consumer, { recursive: true });
      await run(process.execPath, ['desktop.cjs']);
      await run(process.execPath, ['mobile.mjs']);
      if (native) {
        await mkdir(path.join(consumer, 'www'));
        await writeFile(
          path.join(consumer, 'www/index.html'),
          '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body><button id="enable">Enable AI</button><pre id="status">Disabled</pre><script type="module" src="app.js"></script></body></html>',
        );
        await writeFile(
          path.join(consumer, 'capacitor.config.json'),
          JSON.stringify({
            appId: 'com.bendyline.gezel.embedding.tests',
            appName: 'Gezel SDK Consumer',
            webDir: 'www',
          }),
        );
        const toolRequire = createRequire(path.join(root, 'packages/capacitor/package.json'));
        const { build } = createRequire(toolRequire.resolve('tsup'))('esbuild');
        await build({
          entryPoints: [path.join(consumer, 'app.ts')],
          outfile: path.join(consumer, 'www/app.js'),
          bundle: true,
          platform: 'browser',
          format: 'esm',
          target: 'es2022',
        });
        const cap = [path.join(consumer, 'node_modules/@capacitor/cli/bin/capacitor')];
        if (flags.has('--native-ios')) {
          await run(process.execPath, [...cap, 'add', 'ios']);
          const { configureCapacitorProject } = await import(
            pathToFileURL(
              path.join(
                consumer,
                'node_modules/@bendyline/gezel-capacitor/scripts/embedding-package.mjs',
              ),
            ).href
          );
          await configureCapacitorProject({ projectRoot: consumer, platform: 'ios' });
          await run('xcodebuild', [
            '-project',
            'ios/App/App.xcodeproj',
            '-scheme',
            'App',
            '-destination',
            'generic/platform=iOS Simulator',
            '-derivedDataPath',
            path.join(consumer, 'ios-build'),
            'CODE_SIGNING_ALLOWED=NO',
            'ARCHS=arm64',
            'build',
          ]);
        }
        if (flags.has('--native-android')) {
          await run(process.execPath, [...cap, 'add', 'android']);
          const { configureCapacitorProject } = await import(
            pathToFileURL(
              path.join(
                consumer,
                'node_modules/@bendyline/gezel-capacitor/scripts/embedding-package.mjs',
              ),
            ).href
          );
          await configureCapacitorProject({ projectRoot: consumer, platform: 'android' });
          if (env.ANDROID_HOME)
            await writeFile(
              path.join(consumer, 'android/local.properties'),
              `sdk.dir=${env.ANDROID_HOME}\n`,
            );
          await run(path.join(consumer, 'android/gradlew'), [
            '-p',
            path.join(consumer, 'android'),
            '--no-daemon',
            ...(flags.has('--offline') ? ['--offline'] : []),
            'assembleDebug',
          ]);
        }
      }
    },
    { command: 'external embedding SDK consumers', env: process.env },
  );
  process.stdout.write(`Embedding consumers passed: ${consumer}\n`);
} finally {
  if (flags.has('--keep')) process.stdout.write(`Retained consumer: ${consumer}\n`);
  else await rm(consumer, { recursive: true, force: true });
}
