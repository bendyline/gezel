import { constants, access } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { delimiter, join } from 'node:path';

export interface OllamaDetection {
  installed: boolean;
  path?: string;
  installUrl: string;
}

const INSTALL_URL = 'https://ollama.com/download';

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function candidatePaths(): string[] {
  const plat = platform();
  const home = homedir();
  const paths: string[] = [];

  // PATH lookup — works cross-platform when the CLI is installed.
  const pathEnv = process.env.PATH ?? '';
  const binaries = plat === 'win32' ? ['ollama.exe', 'ollama.cmd'] : ['ollama'];
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    for (const bin of binaries) paths.push(join(dir, bin));
  }

  if (plat === 'darwin') {
    paths.push('/Applications/Ollama.app/Contents/MacOS/Ollama');
    paths.push('/Applications/Ollama.app');
    paths.push(join(home, 'Applications', 'Ollama.app'));
    paths.push('/usr/local/bin/ollama');
    paths.push('/opt/homebrew/bin/ollama');
  } else if (plat === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      paths.push(join(localAppData, 'Programs', 'Ollama', 'ollama.exe'));
      paths.push(join(localAppData, 'Programs', 'Ollama', 'ollama app.exe'));
    }
    const programFiles = process.env.ProgramFiles;
    if (programFiles) paths.push(join(programFiles, 'Ollama', 'ollama.exe'));
  } else {
    paths.push('/usr/bin/ollama');
    paths.push('/usr/local/bin/ollama');
    paths.push('/snap/bin/ollama');
    paths.push(join(home, '.local', 'bin', 'ollama'));
  }

  return paths;
}

export async function detectOllamaInstallation(): Promise<OllamaDetection> {
  for (const p of candidatePaths()) {
    if (await exists(p)) {
      return { installed: true, path: p, installUrl: INSTALL_URL };
    }
  }
  return { installed: false, installUrl: INSTALL_URL };
}
