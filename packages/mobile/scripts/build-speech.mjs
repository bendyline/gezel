import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  withDependencyMutationLease,
  withDependencyReadLease,
} from '../../../scripts/dependency-lease.mjs';
import { stageSpeech } from '../../capacitor/scripts/stage-native.mjs';

// A prerelease marks the runtime as staged on purpose, so packing the plugin
// keeps it instead of replacing it with the pinned native release's.
const LOCAL_VERSION = '0.0.0-local';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const args = process.argv.slice(2);
const platform = args[0];
if (!['android', 'ios'].includes(platform))
  throw new Error(
    'Usage: pnpm mobile:build:speech android|ios [--fetch] [--ndk path] [--package VERSION]',
  );
// The app links speech through @bendyline/gezel-capacitor, as every other app
// does, so one build lays out both the app's bundled pack and the plugin's runtime.
const build = args.includes('--package') ? args : [...args, '--package', LOCAL_VERSION];
const lease = args.includes('--fetch') ? withDependencyMutationLease : withDependencyReadLease;
await lease(
  repo,
  async ({ leaseEnv, setChildPid }) => {
    const child = spawn(
      process.env.PYTHON ?? 'python3',
      ['native/mobile/speech/build.py', ...build],
      {
        cwd: repo,
        env: { ...process.env, ...leaseEnv },
        stdio: 'inherit',
      },
    );
    await setChildPid(child.pid);
    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`Speech build exited with ${code}`)),
      );
    });
    await stageSpeech(
      platform,
      path.join(repo, 'native/mobile/.build', `speech-${platform}`, 'package'),
    );
    console.log(`Staged the ${platform} speech runtime into @bendyline/gezel-capacitor.`);
  },
  { command: `Build mobile speech: ${args.join(' ')}` },
);
