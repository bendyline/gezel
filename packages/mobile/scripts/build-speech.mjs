import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  withDependencyMutationLease,
  withDependencyReadLease,
} from '../../../scripts/dependency-lease.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const args = process.argv.slice(2);
if (!['android', 'ios'].includes(args[0]))
  throw new Error('Usage: pnpm mobile:build:speech android|ios [--fetch] [--ndk path]');
const lease = args.includes('--fetch') ? withDependencyMutationLease : withDependencyReadLease;
await lease(
  repo,
  async ({ leaseEnv, setChildPid }) => {
    const child = spawn(
      process.env.PYTHON ?? 'python3',
      ['native/mobile/speech/build.py', ...args, '--models'],
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
  },
  { command: `Build mobile speech: ${args.join(' ')}` },
);
