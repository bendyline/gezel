import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const daemonPath = fileURLToPath(new URL('./stdin-owned-daemon.mjs', import.meta.url));
const daemon = spawn(process.execPath, [daemonPath], {
  stdio: ['pipe', 'pipe', 'inherit'],
  windowsHide: true,
});

let pending = '';
daemon.stdout.setEncoding('utf8');
daemon.stdout.on('data', (chunk) => {
  pending += chunk;
  const newline = pending.indexOf('\n');
  if (newline < 0) return;
  process.stdout.write(pending.slice(0, newline + 1), () => {
    // Deliberately do not call daemon.stdin.end(). Exiting the owner closes
    // its pipe handles exactly as an Electron crash/forced termination does.
    process.exit(0);
  });
});
