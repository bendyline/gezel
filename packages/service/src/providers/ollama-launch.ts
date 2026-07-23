import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { type OllamaDetection, detectOllamaInstallation } from './ollama-detect.js';

export interface LaunchResult {
  started: boolean;
  attempts: number;
  /** The detection result at time of launch (so callers can surface install hints). */
  detection: OllamaDetection;
  error?: string;
}

const MAX_ATTEMPTS = 3;
const POLLS_PER_ATTEMPT = 15;
const POLL_INTERVAL_MS = 200;

/**
 * Try to start a locally-installed Ollama. Does nothing if Ollama isn't
 * installed. Gives up after `MAX_ATTEMPTS` launch tries — each followed by
 * ~3s of polling for the HTTP server to come up.
 *
 * Platform-specific strategy:
 *   • macOS: `open -a Ollama.app` launches the desktop menubar app, which
 *     itself spawns `ollama serve` in the background.
 *   • Windows: start the desktop app binary directly (or fall back to
 *     `ollama serve` if only the CLI is present).
 *   • Linux: `ollama serve` detached — no desktop app exists.
 */
export async function startOllamaIfPossible(baseUrl: string): Promise<LaunchResult> {
  const detection = await detectOllamaInstallation();
  if (!detection.installed) {
    return {
      started: false,
      attempts: 0,
      detection,
      error: 'Ollama is not installed',
    };
  }

  // Already up? No-op.
  if (await probe(baseUrl)) {
    return { started: true, attempts: 0, detection };
  }

  let lastError: string | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await launchDetached(detection.path ?? null);
    } catch (err) {
      lastError = (err as Error).message;
      continue;
    }
    for (let p = 0; p < POLLS_PER_ATTEMPT; p++) {
      await wait(POLL_INTERVAL_MS);
      if (await probe(baseUrl)) {
        return { started: true, attempts: attempt, detection };
      }
    }
  }

  return {
    started: false,
    attempts: MAX_ATTEMPTS,
    detection,
    error:
      lastError ?? `Ollama did not respond on ${baseUrl} after ${MAX_ATTEMPTS} launch attempts`,
  };
}

async function probe(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Launch Ollama in a way that survives this Node process. Detached +
 * ignored stdio is the POSIX pattern; on macOS we lean on `open` (which
 * already detaches) so Ollama's menubar UI appears normally.
 */
async function launchDetached(detectedPath: string | null): Promise<void> {
  const plat = platform();
  if (plat === 'darwin') {
    // Prefer the .app — it gives users the expected menubar icon.
    const appPath = findMacApp(detectedPath);
    if (appPath) {
      await runDetached('open', ['-g', '-a', appPath]);
      return;
    }
    // Fall back to CLI serve — no GUI, but at least the port comes up.
    await runDetached('ollama', ['serve']);
    return;
  }

  if (plat === 'win32') {
    const exe = findWindowsExe(detectedPath);
    if (exe) {
      // `start` decouples the new process from this one without blocking.
      await runDetached('cmd', ['/c', 'start', '""', exe]);
      return;
    }
    await runDetached('ollama.exe', ['serve']);
    return;
  }

  // Linux and everything else — `ollama serve` detached.
  await runDetached('ollama', ['serve']);
}

function findMacApp(detectedPath: string | null): string | null {
  // detectedPath may point at the binary inside the .app; climb to the bundle root.
  if (detectedPath?.includes('Ollama.app')) {
    const idx = detectedPath.indexOf('Ollama.app');
    return detectedPath.slice(0, idx + 'Ollama.app'.length);
  }
  const candidates = ['/Applications/Ollama.app', join(homedir(), 'Applications', 'Ollama.app')];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function findWindowsExe(detectedPath: string | null): string | null {
  if (detectedPath?.toLowerCase().endsWith('.exe')) return detectedPath;
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const app = join(localAppData, 'Programs', 'Ollama', 'ollama app.exe');
    if (existsSync(app)) return app;
    const cli = join(localAppData, 'Programs', 'Ollama', 'ollama.exe');
    if (existsSync(cli)) return cli;
  }
  return null;
}

function runDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
      });
      child.on('error', reject);
      // Don't await the child — we expect it to live past this process.
      child.unref();
      // Give the spawn a tick to surface immediate errors before we return.
      setTimeout(() => resolve(), 50);
    } catch (err) {
      reject(err as Error);
    }
  });
}
