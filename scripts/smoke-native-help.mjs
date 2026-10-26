#!/usr/bin/env node
/**
 * Launch a native binary's help command with bounded time and output.
 *
 * A non-zero exit is acceptable because GPU-backed engines may report a
 * missing device on CI. A silent launch is not: that is how missing loader
 * dependencies can surface on Windows and macOS. Neither is a crash that
 * printed something first: native-v0.1.53's CUDA whisper-server printed its
 * CUDA device and a GGML_ASSERT, aborted, and passed as "produced output".
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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

// NTSTATUS error codes: 0xC0000409 fail-fast/abort, 0xC0000005 access
// violation, 0xC000001D illegal instruction, 0xC0000135 DLL not found.
const WINDOWS_CRASH_STATUS = 0xc0000000;
const CRASH_SIGNALS = new Set(['SIGABRT', 'SIGBUS', 'SIGFPE', 'SIGILL', 'SIGSEGV', 'SIGTRAP']);
const FATAL_OUTPUT =
  /GGML_ASSERT\(|GGML_ABORT|terminate called|Assertion failed|Assertion `[^`]*' failed/;

/** Why a captured `--help` run fails the smoke contract, or null when it passes. */
export function helpSmokeFailure(result, { binary, timeoutMs, maxOutputBytes }) {
  if (result.timedOut) return `${binary} did not finish --help within ${timeoutMs}ms`;
  if (result.outputExceeded) {
    return `${binary} produced more than ${maxOutputBytes} bytes of --help output`;
  }
  if (!/\S/.test(result.output)) {
    return `${binary} produced no --help output (status=${result.status}, signal=${result.signal})`;
  }
  const fatal = result.output.split(/\r?\n/).find((line) => FATAL_OUTPUT.test(line));
  if (fatal) return `${binary} hit a fatal error during --help: ${fatal.trim()}`;
  if (typeof result.status === 'number' && result.status >= WINDOWS_CRASH_STATUS) {
    return `${binary} crashed during --help (status=0x${result.status.toString(16).toUpperCase()})`;
  }
  if (CRASH_SIGNALS.has(result.signal)) return `${binary} crashed during --help (${result.signal})`;
  return null;
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

  const failure = helpSmokeFailure(result, { binary, timeoutMs, maxOutputBytes });
  if (failure) throw new Error(failure);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`\u2717 native help smoke failed: ${error.message}`);
    process.exitCode = 1;
  });
}
