/**
 * Which DLL a Windows engine could not load, and what a person can do about
 * it.
 *
 * An engine that cannot load a DLL it imports dies before `main()` with
 * 0xc0000135 (not found), 0xc0000139 (the copy it found lacks an entry point)
 * or 0xc000007b (a copy built for another architecture), and prints nothing.
 * The status alone read as "the engine crashed, it will restart": nothing a
 * person could act on, and llama-server's quarantine counted it against the
 * build, although the missing piece is usually the machine's. The Microsoft
 * Visual C++ runtime is the common one: every engine imports it, the NSIS
 * installer installs it, and nothing installs it for an npm or CLI install.
 * Every other build needs it too, so switching builds over it only moves the
 * failure.
 *
 * So the supervisor asks this module when an engine dies that way before it
 * is ready. It reads the engine's import table, and the import tables of the
 * DLLs beside it, and resolves each import as the loader does for a desktop
 * program: the engine's own folder, then System32, then PATH. Only load-time
 * imports count. A backend ggml loads later with LoadLibrary fails softly,
 * and a delay-load import has not been attempted yet.
 */

import { closeSync, openSync, readSync } from 'node:fs';
import { win32 } from 'node:path';

/** The NTSTATUS exits that mean a DLL could not be loaded at startup. */
export const WINDOWS_DLL_LOAD_STATUSES: ReadonlySet<number> = new Set([
  0xc0000135, 0xc0000139, 0xc000007b,
]);

const ENTRY_POINT_NOT_FOUND = 0xc0000139;

export type PeArch = 'arm64' | 'x64' | 'x86' | 'arm64ec' | 'other';

const MACHINES: ReadonlyMap<number, PeArch> = new Map([
  [0xaa64, 'arm64'],
  [0x8664, 'x64'],
  [0x14c, 'x86'],
  [0xa641, 'arm64ec'],
]);

const ARCH_LABEL: Readonly<Record<PeArch, string>> = {
  arm64: 'ARM64',
  x64: 'x64',
  x86: 'x86',
  arm64ec: 'ARM64EC',
  other: 'another architecture',
};

/** Microsoft's permalink to the current Visual C++ v14 redistributable for one architecture. */
export function vcRedistributableUrl(arch: PeArch): string {
  return `https://aka.ms/vs/17/release/vc_redist.${arch === 'arm64' ? 'arm64' : 'x64'}.exe`;
}

export interface DllFiles {
  /** Up to `length` bytes of `path` from `offset`; null when it cannot be read. */
  read(path: string, offset: number, length: number): Uint8Array | null;
}

export const nodeDllFiles: DllFiles = {
  read(path, offset, length) {
    let fd: number | undefined;
    try {
      fd = openSync(path, 'r');
      const buffer = Buffer.alloc(length);
      return buffer.subarray(0, readSync(fd, buffer, 0, length, offset));
    } catch {
      return null;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  },
};

export interface PeImports {
  arch: PeArch;
  /** DLL names from the import directory, as written. */
  imports: string[];
}

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_IMPORT_DESCRIPTORS = 512;

/** The architecture and load-time imports of a PE file, or null when it is not one. */
export function readPeImports(path: string, files: DllFiles = nodeDllFiles): PeImports | null {
  let head = files.read(path, 0, 4096);
  if (!head || head.length < 0x40 || head[0] !== 0x4d || head[1] !== 0x5a) return null;
  const peOffset = view(head).getUint32(0x3c, true);
  if (peOffset + 24 > MAX_HEADER_BYTES) return null;
  if (peOffset + 24 > head.length) head = files.read(path, 0, peOffset + 24) ?? head;
  if (peOffset + 24 > head.length) return null;
  let h = view(head);
  if (h.getUint32(peOffset, true) !== 0x00004550) return null;
  const arch = MACHINES.get(h.getUint16(peOffset + 4, true)) ?? 'other';
  const sectionCount = h.getUint16(peOffset + 6, true);
  const optionalSize = h.getUint16(peOffset + 20, true);
  const optional = peOffset + 24;
  const sections = optional + optionalSize;
  const headerEnd = sections + 40 * sectionCount;
  if (headerEnd > MAX_HEADER_BYTES) return null;
  if (headerEnd > head.length) {
    head = files.read(path, 0, headerEnd) ?? head;
    if (headerEnd > head.length) return null;
    h = view(head);
  }
  const magic = h.getUint16(optional, true);
  const directories = optional + (magic === 0x20b ? 112 : 96);
  const directoryCount = h.getUint32(optional + (magic === 0x20b ? 108 : 92), true);
  if (directoryCount < 2 || directories + 16 > sections) return { arch, imports: [] };
  const importRva = h.getUint32(directories + 8, true);
  if (importRva === 0) return { arch, imports: [] };

  const fileOffset = (rva: number): number | null => {
    for (let i = 0; i < sectionCount; i++) {
      const s = sections + 40 * i;
      const virtualSize = h.getUint32(s + 8, true);
      const virtualAddress = h.getUint32(s + 12, true);
      const rawSize = h.getUint32(s + 16, true);
      const rawPointer = h.getUint32(s + 20, true);
      if (rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, rawSize)) {
        return rawPointer + (rva - virtualAddress);
      }
    }
    return null;
  };

  const descriptorsAt = fileOffset(importRva);
  if (descriptorsAt === null) return { arch, imports: [] };
  const descriptors = files.read(path, descriptorsAt, 20 * MAX_IMPORT_DESCRIPTORS);
  if (!descriptors) return { arch, imports: [] };
  const d = view(descriptors);
  const imports: string[] = [];
  for (let at = 0; at + 20 <= descriptors.length; at += 20) {
    const nameRva = d.getUint32(at + 12, true);
    if (nameRva === 0) break;
    const nameAt = fileOffset(nameRva);
    const raw = nameAt === null ? null : files.read(path, nameAt, 256);
    if (!raw) continue;
    const end = raw.indexOf(0);
    const name = String.fromCharCode(...raw.subarray(0, end === -1 ? raw.length : end));
    if (/^[\w.+-]+$/.test(name)) imports.push(name);
  }
  return { arch, imports };
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export interface MissingDll {
  dll: string;
  /** File name of the module that imports it. */
  importedBy: string;
  /** The engine's architecture. */
  arch: PeArch;
  /** Set when Windows would load a copy built for another architecture instead. */
  found?: { path: string; arch: PeArch; inEngineDir: boolean };
}

export interface DllSearch {
  /** `%SystemRoot%\System32`. */
  systemDir: string;
  /** The child's PATH entries, in order. */
  pathDirs: readonly string[];
  files?: DllFiles;
}

export interface DllCheck {
  /** The engine's architecture, or null when the binary is not a readable PE. */
  arch: PeArch | null;
  /** The first import that cannot be loaded, or null when all of them can. */
  missing: MissingDll | null;
  /** Whether anything in the engine's folder imports the Visual C++ runtime. */
  usesVcRuntime: boolean;
}

const VC_RUNTIME_DLL =
  /^(?:vcruntime140(?:_1|_threads)?|msvcp140(?:_[a-z0-9_]+)?|concrt140)\.dll$/i;
const GRAPHICS_DRIVER_DLL = /^(?:vulkan-1|nvcuda|nvml|opencl)\.dll$/i;
const ENGINE_FILE_DLL =
  /^(?:ggml|llama|mtmd|whisper|stable-diffusion|cublas|cudart|nvrtc|nvjitlink)[\w.-]*\.dll$/i;
const API_SET = /^(?:api|ext)-ms-/i;
const MAX_MODULES = 128;

/** Resolve an engine's load-time imports the way the Windows loader would. */
export function checkEngineDlls(binary: string, search: DllSearch): DllCheck {
  const files = search.files ?? nodeDllFiles;
  const root = readPeImports(binary, files);
  if (!root) return { arch: null, missing: null, usesVcRuntime: false };
  const engineDir = win32.dirname(binary);
  const seen = new Set([win32.basename(binary).toLowerCase()]);
  const queue: { path: string; imports: string[] }[] = [{ path: binary, imports: root.imports }];
  let usesVcRuntime = false;
  for (let module = queue.shift(); module && seen.size < MAX_MODULES; module = queue.shift()) {
    for (const dll of module.imports) {
      if (VC_RUNTIME_DLL.test(dll)) usesVcRuntime = true;
      const key = dll.toLowerCase();
      if (API_SET.test(key) || seen.has(key)) continue;
      seen.add(key);
      const hit = locateDll(dll, engineDir, search, files);
      const importedBy = win32.basename(module.path);
      if (!hit) {
        return { arch: root.arch, missing: { dll, importedBy, arch: root.arch }, usesVcRuntime };
      }
      if (!archLoads(root.arch, hit.info.arch, hit.where === 'system')) {
        const found = { path: hit.path, arch: hit.info.arch, inEngineDir: hit.where === 'engine' };
        return {
          arch: root.arch,
          missing: { dll, importedBy, arch: root.arch, found },
          usesVcRuntime,
        };
      }
      // System and PATH DLLs resolve their own dependencies from System32.
      if (hit.where === 'engine') queue.push({ path: hit.path, imports: hit.info.imports });
    }
  }
  return { arch: root.arch, missing: null, usesVcRuntime };
}

function locateDll(
  dll: string,
  engineDir: string,
  search: DllSearch,
  files: DllFiles,
): { path: string; where: 'engine' | 'system' | 'path'; info: PeImports } | null {
  const candidates: [string, 'engine' | 'system' | 'path'][] = [
    [engineDir, 'engine'],
    [search.systemDir, 'system'],
    ...search.pathDirs.map((dir): [string, 'path'] => [dir, 'path']),
  ];
  for (const [dir, where] of candidates) {
    const path = win32.join(dir, dll);
    const info = readPeImports(path, files);
    if (info) return { path, where, info };
  }
  return null;
}

/**
 * Whether a process of `engine` architecture loads a DLL of `file`
 * architecture. On Windows on ARM, System32 holds ARM64X files that also
 * serve emulated x64 processes, so an x64 engine accepts an ARM64 file there.
 */
function archLoads(engine: PeArch, file: PeArch, inSystemDir: boolean): boolean {
  return file === engine || (engine === 'x64' && file === 'arm64' && inSystemDir);
}

export type DllLoadFailureKind = 'vc-runtime' | 'graphics-driver' | 'engine-files' | 'other';

export interface DllLoadFailure {
  kind: DllLoadFailureKind;
  /** The DLL at fault, when one was identified. */
  dll?: string;
  /** The engine's architecture, which picks the runtime download. */
  arch: PeArch;
  /**
   * True when the cause is the machine's rather than the build's, so another
   * build of the same engine would fail the same way.
   */
  machineWide: boolean;
  /** For the person: what is wrong and what to do. */
  summary: string;
  /** For logs. */
  reason: string;
}

/**
 * Explain an engine that exited with `status` before it was ready, from what
 * {@link checkEngineDlls} found. Null when the status is not a DLL load
 * failure, or the imports all resolve and nothing better than the status can
 * be said.
 */
export function explainDllLoadFailure(
  status: number,
  binary: string,
  check: DllCheck,
): DllLoadFailure | null {
  const code = status >>> 0;
  if (!WINDOWS_DLL_LOAD_STATUSES.has(code)) return null;
  const hex = `0x${code.toString(16).padStart(8, '0')}`;
  const arch = check.arch ?? 'x64';
  const label = ARCH_LABEL[arch];
  const runtime = `the Microsoft Visual C++ Redistributable (${label})`;
  const install = `Install it from ${vcRedistributableUrl(arch)}, then try again.`;
  const missing = check.missing;

  if (!missing) {
    if (code !== ENTRY_POINT_NOT_FOUND || !check.usesVcRuntime) return null;
    return {
      kind: 'vc-runtime',
      arch,
      machineWide: false,
      summary: `A Windows component this engine uses is older than the engine expects. That is usually ${runtime}. Install the latest version from ${vcRedistributableUrl(arch)}, then try again.`,
      reason: `exited with ${hex} (entry point not found) and every import resolved; an outdated Visual C++ runtime is the likely cause`,
    };
  }

  const { dll, found } = missing;
  if (VC_RUNTIME_DLL.test(dll)) {
    return {
      kind: 'vc-runtime',
      arch,
      dll,
      machineWide: true,
      summary: found
        ? `This PC has the ${ARCH_LABEL[found.arch]} version of the Microsoft Visual C++ Redistributable, but Gezel's on-device engines need the ${label} version. ${install}`
        : `This PC does not have ${runtime}, which Gezel's on-device engines need. ${install}`,
      reason: found
        ? `${dll} resolves to ${found.path}, built for ${found.arch}; the engine is ${arch}`
        : `${dll} (imported by ${missing.importedBy}) is not in the engine folder, System32 or PATH`,
    };
  }
  if (GRAPHICS_DRIVER_DLL.test(dll)) {
    const what = /^vulkan-1\./i.test(dll)
      ? 'a graphics driver with Vulkan support'
      : /^opencl\./i.test(dll)
        ? 'a graphics driver with OpenCL support'
        : 'the NVIDIA graphics driver';
    return {
      kind: 'graphics-driver',
      arch,
      dll,
      machineWide: false,
      summary: `This engine needs ${what}, and Windows could not find it (${dll}). Install or update your graphics driver, then try again.`,
      reason: `${dll} (imported by ${missing.importedBy}) is not on this machine${found ? `; ${found.path} is built for ${found.arch}` : ''}`,
    };
  }
  if (found) {
    return {
      kind: found.inEngineDir ? 'engine-files' : 'other',
      arch,
      dll,
      machineWide: false,
      summary: found.inEngineDir
        ? `The on-device engine's files are damaged: ${dll} is built for ${ARCH_LABEL[found.arch]} PCs and this engine is ${label}. Reinstall Gezel to restore them.`
        : `Windows loads ${dll} from ${win32.normalize(win32.dirname(found.path))}, a folder on your PATH, but that copy is built for ${ARCH_LABEL[found.arch]} PCs and this engine is ${label}. Remove that folder from PATH, then try again.`,
      reason: `${dll} resolves to ${found.path}, built for ${found.arch}; the engine is ${arch}`,
    };
  }
  if (ENGINE_FILE_DLL.test(dll)) {
    return {
      kind: 'engine-files',
      arch,
      dll,
      machineWide: false,
      summary: `The on-device engine's files are incomplete: ${dll} is missing from ${win32.normalize(win32.dirname(binary))}. Reinstall Gezel to restore it.`,
      reason: `${dll} (imported by ${missing.importedBy}) is missing from the engine folder`,
    };
  }
  return {
    kind: 'other',
    arch,
    dll,
    machineWide: false,
    summary: `Windows could not find ${dll}, which ${missing.importedBy} needs to start.`,
    reason: `${dll} (imported by ${missing.importedBy}) is not in the engine folder, System32 or PATH`,
  };
}

/**
 * The PATH entries of a child's environment, whichever case the key is spelled
 * in. When `{ ...process.env, ...launch.env }` holds both `Path` and `PATH`,
 * Node gives the child the first key in sorted order, so this reads that one.
 */
export function windowsPathDirs(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string[] {
  const key = Object.keys(env)
    .filter((name) => name.toLowerCase() === 'path')
    .sort()[0];
  const value = key ? env[key] : undefined;
  return [
    ...new Set(
      (value ?? '')
        .split(';')
        .map((dir) => dir.trim())
        .filter(Boolean),
    ),
  ];
}

/** Check and explain in one call, for a supervisor that saw `status`. Null when there is nothing to add. */
export function diagnoseDllLoadFailure(
  status: number | null,
  binary: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  files: DllFiles = nodeDllFiles,
): DllLoadFailure | null {
  if (status === null || !WINDOWS_DLL_LOAD_STATUSES.has(status >>> 0)) return null;
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? 'C:\\Windows';
  const check = checkEngineDlls(binary, {
    systemDir: win32.join(systemRoot, 'System32'),
    pathDirs: windowsPathDirs(env),
    files,
  });
  return explainDllLoadFailure(status, binary, check);
}

/**
 * Before anything starts: the machine-wide runtime `binary` imports and this
 * PC cannot load, or null. Answers as if the engine had exited "DLL not
 * found", so Gezel can say so before a person first asks for a model.
 */
export function missingMachineRuntime(
  binary: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  files: DllFiles = nodeDllFiles,
): DllLoadFailure | null {
  const failure = diagnoseDllLoadFailure(0xc0000135, binary, env, files);
  return failure?.machineWide ? failure : null;
}
