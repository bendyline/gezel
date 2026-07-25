#!/usr/bin/env node
/**
 * Launch a native binary's help command with bounded time and output.
 *
 * A non-zero exit is acceptable because GPU-backed engines may report a
 * missing device on CI. A silent launch is not: that is how missing loader
 * dependencies can surface on Windows and macOS.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function positiveInteger(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`);
  }
  return parsed;
}

async function captureHelp(binary, timeoutMs, maxOutputBytes) {
  return new Promise((resolveCapture, rejectCapture) => {
    const child = spawn(binary, ['--help'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const chunks = [];
    let capturedBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let settled = false;

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const capture = (chunk) => {
      capturedBytes += chunk.length;
      if (capturedBytes > maxOutputBytes) {
        outputExceeded = true;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    };

    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', (error) => finish(() => rejectCapture(error)));
    child.on('close', (status, signal) =>
      finish(() =>
        resolveCapture({
          output: Buffer.concat(chunks).toString('utf8'),
          outputExceeded,
          signal,
          status,
          timedOut,
        }),
      ),
    );

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
  });
}

async function main() {
  const [binaryArgument, ...extraArguments] = process.argv.slice(2);
  if (!binaryArgument || extraArguments.length > 0) {
    throw new Error('usage: smoke-native-help.mjs <native-binary>');
  }

  const binary = resolve(binaryArgument);
  const timeoutMs = positiveInteger(
    process.env.GEZEL_NATIVE_HELP_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS),
    'GEZEL_NATIVE_HELP_TIMEOUT_MS',
  );
  const maxOutputBytes = positiveInteger(
    process.env.GEZEL_NATIVE_HELP_MAX_OUTPUT_BYTES ?? String(DEFAULT_MAX_OUTPUT_BYTES),
    'GEZEL_NATIVE_HELP_MAX_OUTPUT_BYTES',
  );
  const result = await captureHelp(binary, timeoutMs, maxOutputBytes);
  const preview = result.output.split(/\r?\n/).slice(0, 20).join('\n');
  if (preview) process.stdout.write(`${preview}\n`);

  if (result.timedOut) {
    throw new Error(`${binary} did not finish --help within ${timeoutMs}ms`);
  }
  if (result.outputExceeded) {
    throw new Error(`${binary} produced more than ${maxOutputBytes} bytes of --help output`);
  }
  if (!/\S/.test(result.output)) {
    throw new Error(
      `${binary} produced no --help output (status=${result.status}, signal=${result.signal})`,
    );
  }
}

main().catch((error) => {
  console.error(`\u2717 native help smoke failed: ${error.message}`);
  process.exitCode = 1;
});
