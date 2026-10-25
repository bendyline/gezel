import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type DllFiles,
  checkEngineDlls,
  diagnoseDllLoadFailure,
  explainDllLoadFailure,
  missingMachineRuntime,
  readPeImports,
  vcRedistributableUrl,
  windowsPathDirs,
} from './missing-dll.js';

const ARM64 = 0xaa64;
const X64 = 0x8664;

/** A minimal PE32+ image: one `.idata` section holding the import directory. */
function pe(machine: number, imports: string[]): Uint8Array {
  const sectionRva = 0x1000;
  const rawAt = 0x200;
  const descriptors = 20 * (imports.length + 1);
  const names = imports.map((name) => [...name].map((c) => c.charCodeAt(0)).concat(0));
  const sectionSize = descriptors + names.reduce((sum, n) => sum + n.length, 0);
  const bytes = new Uint8Array(rawAt + sectionSize);
  const v = new DataView(bytes.buffer);
  bytes.set([0x4d, 0x5a]);
  v.setUint32(0x3c, 0x40, true);
  v.setUint32(0x40, 0x00004550, true);
  v.setUint16(0x44, machine, true);
  v.setUint16(0x46, 1, true);
  v.setUint16(0x54, 240, true);
  const optional = 0x58;
  v.setUint16(optional, 0x20b, true);
  v.setUint32(optional + 108, 16, true);
  v.setUint32(optional + 112 + 8, sectionRva, true);
  v.setUint32(optional + 112 + 12, descriptors, true);
  const section = optional + 240;
  bytes.set(
    [...'.idata'].map((c) => c.charCodeAt(0)),
    section,
  );
  v.setUint32(section + 8, sectionSize, true);
  v.setUint32(section + 12, sectionRva, true);
  v.setUint32(section + 16, sectionSize, true);
  v.setUint32(section + 20, rawAt, true);
  let nameAt = descriptors;
  names.forEach((name, i) => {
    v.setUint32(rawAt + 20 * i + 12, sectionRva + nameAt, true);
    bytes.set(name, rawAt + nameAt);
    nameAt += name.length;
  });
  return bytes;
}

function memoryFiles(entries: Record<string, Uint8Array>): DllFiles {
  const byPath = new Map(
    Object.entries(entries).map(([path, bytes]) => [path.toLowerCase(), bytes]),
  );
  return {
    read(path, offset, length) {
      const bytes = byPath.get(path.toLowerCase());
      return bytes ? bytes.subarray(offset, offset + length) : null;
    },
  };
}

const ENGINE_DIR = 'C:\\gezel\\native-bin\\win32-arm64-cpu';
const SYSTEM = 'C:\\Windows\\System32';
const SERVER = win32.join(ENGINE_DIR, 'gezel-llama-server.exe');
const crt = ['VCRUNTIME140.dll', 'api-ms-win-crt-runtime-l1-1-0.dll', 'KERNEL32.dll'];

/** llama-server and its sibling DLLs, as the ARM64 CPU archive ships them. */
function engine(machine = ARM64): Record<string, Uint8Array> {
  return {
    [SERVER]: pe(machine, ['llama-server-impl.dll', ...crt]),
    [win32.join(ENGINE_DIR, 'llama-server-impl.dll')]: pe(machine, [
      'ggml-base.dll',
      'MSVCP140.dll',
      ...crt,
    ]),
    [win32.join(ENGINE_DIR, 'ggml-base.dll')]: pe(machine, ['MSVCP140.dll', ...crt]),
  };
}

function system(machine = ARM64, dlls = ['VCRUNTIME140.dll', 'MSVCP140.dll']) {
  return Object.fromEntries(
    ['KERNEL32.dll', ...dlls].map((dll) => [win32.join(SYSTEM, dll), pe(machine, [])]),
  );
}

const search = (files: DllFiles, pathDirs: string[] = []) => ({
  systemDir: SYSTEM,
  pathDirs,
  files,
});

describe('readPeImports', () => {
  it('reads the machine and the import directory', () => {
    const files = memoryFiles({ 'C:\\a.exe': pe(ARM64, ['ggml.dll', 'KERNEL32.dll']) });
    expect(readPeImports('C:\\a.exe', files)).toEqual({
      arch: 'arm64',
      imports: ['ggml.dll', 'KERNEL32.dll'],
    });
  });

  it('answers null for a file that is not a PE image', () => {
    const files = memoryFiles({ 'C:\\a.exe': new Uint8Array([1, 2, 3]) });
    expect(readPeImports('C:\\a.exe', files)).toBeNull();
    expect(readPeImports('C:\\missing.exe', files)).toBeNull();
  });
});

describe('checkEngineDlls', () => {
  it('resolves siblings from the engine folder and the runtime from System32', () => {
    const files = memoryFiles({ ...engine(), ...system() });
    expect(checkEngineDlls(SERVER, search(files))).toEqual({
      arch: 'arm64',
      missing: null,
      usesVcRuntime: true,
    });
  });

  it('accepts a runtime carried beside the engine, as the Store package does', () => {
    const files = memoryFiles({
      ...engine(),
      ...system(ARM64, []),
      [win32.join(ENGINE_DIR, 'VCRUNTIME140.dll')]: pe(ARM64, []),
      [win32.join(ENGINE_DIR, 'MSVCP140.dll')]: pe(ARM64, []),
    });
    expect(checkEngineDlls(SERVER, search(files)).missing).toBeNull();
  });

  it('names the first import nothing provides, and who imports it', () => {
    const files = memoryFiles({ ...engine(), ...system(ARM64, ['VCRUNTIME140.dll']) });
    expect(checkEngineDlls(SERVER, search(files)).missing).toEqual({
      dll: 'MSVCP140.dll',
      importedBy: 'llama-server-impl.dll',
      arch: 'arm64',
    });
  });

  it('reports a copy built for another architecture', () => {
    // On Windows on ARM the x64 redistributable leaves x64-only files in System32.
    const files = memoryFiles({ ...engine(), ...system(X64) });
    expect(checkEngineDlls(SERVER, search(files)).missing).toMatchObject({
      dll: 'VCRUNTIME140.dll',
      found: { arch: 'x64', inEngineDir: false },
    });
  });

  it('lets an x64 engine load the ARM64X files in System32 on Windows on ARM', () => {
    const files = memoryFiles({ ...engine(X64), ...system(ARM64) });
    expect(checkEngineDlls(SERVER, search(files)).missing).toBeNull();
  });

  it('finds a DLL on PATH after the engine folder and System32', () => {
    const cuda = 'C:\\cuda\\bin';
    const files = memoryFiles({
      ...engine(),
      ...system(),
      [SERVER]: pe(ARM64, ['cublas64_13.dll', ...crt]),
      [win32.join(cuda, 'cublas64_13.dll')]: pe(ARM64, []),
    });
    expect(checkEngineDlls(SERVER, search(files)).missing).not.toBeNull();
    expect(checkEngineDlls(SERVER, search(files, [cuda])).missing).toBeNull();
  });
});

describe('explainDllLoadFailure', () => {
  const NOT_FOUND = 0xc0000135;

  it('sends a machine without the Visual C++ runtime to Microsoft, for its architecture', () => {
    const files = memoryFiles({ ...engine(), ...system(ARM64, []) });
    const failure = explainDllLoadFailure(
      NOT_FOUND,
      SERVER,
      checkEngineDlls(SERVER, search(files)),
    );
    expect(failure).toMatchObject({
      kind: 'vc-runtime',
      dll: 'VCRUNTIME140.dll',
      machineWide: true,
    });
    expect(failure?.summary).toBe(
      `This PC does not have the Microsoft Visual C++ Redistributable (ARM64), which Gezel's on-device engines need. Install it from ${vcRedistributableUrl('arm64')}, then try again.`,
    );
    expect(vcRedistributableUrl('arm64')).toBe('https://aka.ms/vs/17/release/vc_redist.arm64.exe');
  });

  it('tells an ARM64 engine with only the x64 runtime which one to install', () => {
    const files = memoryFiles({ ...engine(), ...system(X64) });
    const failure = explainDllLoadFailure(
      NOT_FOUND,
      SERVER,
      checkEngineDlls(SERVER, search(files)),
    );
    expect(failure?.machineWide).toBe(true);
    expect(failure?.summary).toMatch(/has the x64 version .* need the ARM64 version/);
  });

  it('says a missing sibling DLL means the engine files are incomplete', () => {
    const files = memoryFiles({ ...engine(), ...system() });
    const { [win32.join(ENGINE_DIR, 'ggml-base.dll')]: _, ...withoutGgml } = {
      ...engine(),
      ...system(),
    };
    const failure = explainDllLoadFailure(
      NOT_FOUND,
      SERVER,
      checkEngineDlls(SERVER, search(memoryFiles(withoutGgml))),
    );
    expect(checkEngineDlls(SERVER, search(files)).missing).toBeNull();
    expect(failure).toMatchObject({
      kind: 'engine-files',
      dll: 'ggml-base.dll',
      machineWide: false,
    });
    expect(failure?.summary).toContain(ENGINE_DIR);
  });

  it('points a missing Vulkan loader at the graphics driver', () => {
    const files = memoryFiles({
      ...engine(X64),
      ...system(X64),
      [SERVER]: pe(X64, ['vulkan-1.dll', ...crt]),
    });
    const failure = explainDllLoadFailure(
      NOT_FOUND,
      SERVER,
      checkEngineDlls(SERVER, search(files)),
    );
    expect(failure).toMatchObject({ kind: 'graphics-driver', machineWide: false });
    expect(failure?.summary).toContain('a graphics driver with Vulkan support');
  });

  it('suspects an outdated runtime for a missing entry point, without blaming the machine outright', () => {
    const files = memoryFiles({ ...engine(), ...system() });
    const failure = explainDllLoadFailure(
      0xc0000139,
      SERVER,
      checkEngineDlls(SERVER, search(files)),
    );
    expect(failure).toMatchObject({ kind: 'vc-runtime', machineWide: false });
    expect(failure?.summary).toContain('older than the engine expects');
  });

  it('adds nothing when the status is not a DLL failure or every import resolves', () => {
    const files = memoryFiles({ ...engine(), ...system() });
    const check = checkEngineDlls(SERVER, search(files));
    expect(explainDllLoadFailure(0xc0000005, SERVER, check)).toBeNull();
    expect(explainDllLoadFailure(NOT_FOUND, SERVER, check)).toBeNull();
  });
});

describe('missingMachineRuntime', () => {
  it('reports only a runtime the whole machine lacks', () => {
    const env = { SystemRoot: 'C:\\Windows' };
    const without = memoryFiles({ ...engine(), ...system(ARM64, []) });
    expect(missingMachineRuntime(SERVER, env, without)).toMatchObject({
      kind: 'vc-runtime',
      arch: 'arm64',
    });
    expect(
      missingMachineRuntime(SERVER, env, memoryFiles({ ...engine(), ...system() })),
    ).toBeNull();
    // A damaged engine folder is the build's problem, not the machine's.
    const { [win32.join(ENGINE_DIR, 'ggml-base.dll')]: _, ...damaged } = {
      ...engine(),
      ...system(),
    };
    expect(missingMachineRuntime(SERVER, env, memoryFiles(damaged))).toBeNull();
  });
});

describe('diagnoseDllLoadFailure', () => {
  it('reads PATH and System32 from the child environment, however it is spelled', () => {
    expect(windowsPathDirs({ Path: 'C:\\a; C:\\b;;C:\\a' })).toEqual(['C:\\a', 'C:\\b']);
    // Node hands the child the first spelling in sorted order: PATH before Path.
    expect(windowsPathDirs({ Path: 'C:\\parent', PATH: 'C:\\engine;C:\\parent' })).toEqual([
      'C:\\engine',
      'C:\\parent',
    ]);
    const files = memoryFiles({ ...engine(), ...system(ARM64, []) });
    const failure = diagnoseDllLoadFailure(
      0xc0000135,
      SERVER,
      { SystemRoot: 'C:\\Windows' },
      files,
    );
    expect(failure?.kind).toBe('vc-runtime');
    expect(diagnoseDllLoadFailure(null, SERVER, {}, files)).toBeNull();
    expect(diagnoseDllLoadFailure(1, SERVER, {}, files)).toBeNull();
  });
});
