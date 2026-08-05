import { spawn } from 'node:child_process';

const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], {
  stdio: 'ignore',
  windowsHide: true,
});

// Keep stdin flowing but deliberately ignore EOF: this fixture exercises the
// bounded taskkill /T /F fallback rather than the graceful path.
process.stdin.resume();
process.stdout.write(`${JSON.stringify({ daemonPid: process.pid, workerPid: worker.pid })}\n`);
setInterval(() => {}, 60_000);
