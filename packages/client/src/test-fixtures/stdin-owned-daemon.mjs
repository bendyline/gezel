import { spawn } from 'node:child_process';

const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], {
  stdio: 'ignore',
  windowsHide: true,
});

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  try {
    worker.kill('SIGKILL');
  } catch {
    // It may have already exited.
  }
  const timer = setTimeout(() => process.exit(0), 2_000);
  timer.unref();
  worker.once('exit', () => process.exit(0));
};

process.stdin.on('end', stop);
process.stdin.on('error', stop);
process.stdin.resume();
process.stdout.write(`${JSON.stringify({ daemonPid: process.pid, workerPid: worker.pid })}\n`);
setInterval(() => {}, 60_000);
