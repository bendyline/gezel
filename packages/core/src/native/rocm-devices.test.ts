import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LLAMA_ROCM_BLOCKER_ENV,
  ROCM_GFX_TARGETS,
  checkRocmBuild,
  checkRocmBuildAsync,
  gfxFromTargetVersion,
  linuxKfdGfxTargets,
  parseRocmDeviceLog,
  publishRocmCheck,
  readRocmBlocker,
  rocmCheckFromDevices,
  rocmDeviceCachePath,
  rocmEngineEnv,
  rocmWorthDownloading,
} from './rocm-devices.js';

// What ggml's HIP backend prints while `--list-devices` loads it, on a Ryzen
// desktop with its small RDNA2 iGPU enabled beside a Radeon AI PRO R9700.
const MIXED_LOG = [
  'ggml_cuda_init: found 2 ROCm devices (Total VRAM: 33136 MiB):',
  '  Device 0: AMD Radeon(TM) Graphics, gfx1036 (0x1036), VMM: no, Wave Size: 32, VRAM: 512 MiB',
  '  Device 1: AMD Radeon AI PRO R9700, gfx1201 (0x1201), VMM: no, Wave Size: 32, VRAM: 32624 MiB',
  'load_backend: loaded ROCm backend from C:\\n\\win32-x64-rocm\\ggml-hip.dll',
  'Available devices:',
  '  ROCm0: AMD Radeon(TM) Graphics (512 MiB, 480 MiB free)',
  '  ROCm1: AMD Radeon AI PRO R9700 (32624 MiB, 31914 MiB free)',
].join('\r\n');

describe('parseRocmDeviceLog', () => {
  it('reads the lines llama-server prints with its timestamp and level prefix', () => {
    // gezel-llama-server --log-verbosity 4 --list-devices on a Radeon AI PRO R9700.
    const output = [
      '0.00.042.993 I ggml_cuda_init: found 1 ROCm devices (Total VRAM: 32624 MiB):',
      '0.00.043.005 I   Device 0: AMD Radeon AI PRO R9700, gfx1201 (0x1201), VMM: no, Wave Size: 32, VRAM: 32624 MiB',
      'Available devices:',
      '  ROCm0: AMD Radeon AI PRO R9700 (32624 MiB, 32472 MiB free)',
    ].join('\n');
    expect(parseRocmDeviceLog(output)).toEqual([
      { index: 0, name: 'AMD Radeon AI PRO R9700', gfx: 'gfx1201' },
    ]);
  });

  it('reads the HIP index, name and base architecture of every GPU', () => {
    expect(parseRocmDeviceLog(MIXED_LOG)).toEqual([
      { index: 0, name: 'AMD Radeon(TM) Graphics', gfx: 'gfx1036' },
      { index: 1, name: 'AMD Radeon AI PRO R9700', gfx: 'gfx1201' },
    ]);
  });

  it('drops feature suffixes and ignores other lines', () => {
    expect(
      parseRocmDeviceLog(
        '  Device 0: AMD Instinct MI210, gfx90a:sramecc+:xnack- (0x90a), VMM: yes',
      ),
    ).toEqual([{ index: 0, name: 'AMD Instinct MI210', gfx: 'gfx90a' }]);
    expect(
      parseRocmDeviceLog('ggml_cuda_init: failed to initialize ROCm: no ROCm-capable device'),
    ).toEqual([]);
  });
});

describe('rocmCheckFromDevices', () => {
  const targets = ['gfx1100', 'gfx1201'];

  it('hides a GPU the build has no code for beside one it supports', () => {
    expect(rocmCheckFromDevices(parseRocmDeviceLog(MIXED_LOG), targets)).toMatchObject({
      blocker: null,
      visibleDevices: [1],
    });
  });

  it('leaves visibility alone when every GPU is supported', () => {
    const devices = [{ index: 0, name: 'Radeon RX 7900 XTX', gfx: 'gfx1100' }];
    expect(rocmCheckFromDevices(devices, targets)).toMatchObject({
      blocker: null,
      visibleDevices: null,
    });
  });

  it('passes the build over for GPUs it has no code for, naming them', () => {
    const check = rocmCheckFromDevices(
      [{ index: 0, name: 'Radeon RX 6800', gfx: 'gfx1030' }],
      targets,
    );
    expect(check.blocker?.kind).toBe('no-supported-gpu');
    expect(check.blocker?.detail).toContain('Radeon RX 6800 (gfx1030)');
  });

  it('treats no GPU at all as a failed probe, and a build without a target list as supporting all', () => {
    expect(rocmCheckFromDevices([], targets).blocker?.kind).toBe('probe-failed');
    expect(rocmCheckFromDevices([{ index: 0, name: 'x', gfx: 'gfx1030' }], null)).toMatchObject({
      blocker: null,
      visibleDevices: null,
    });
  });
});

describe('gfx names from the KFD topology', () => {
  it('converts gfx_target_version', () => {
    expect(gfxFromTargetVersion(120001)).toBe('gfx1201');
    expect(gfxFromTargetVersion(110501)).toBe('gfx1151');
    expect(gfxFromTargetVersion(90010)).toBe('gfx90a');
    expect(gfxFromTargetVersion(0)).toBeNull();
  });

  it('lists GPU nodes and skips CPU nodes', () => {
    const files: Record<string, string> = {
      '/sys/class/kfd/kfd/topology/nodes/0/properties':
        'cpu_cores_count 16\ngfx_target_version 0\n',
      '/sys/class/kfd/kfd/topology/nodes/1/properties':
        'simd_count 128\ngfx_target_version 120001\n',
    };
    const io = {
      listDir: () => ['0', '1'],
      readFile: (path: string) => {
        const text = files[path];
        if (text === undefined) throw new Error('ENOENT');
        return text;
      },
    };
    expect(linuxKfdGfxTargets(io)).toEqual(['gfx1201']);
    expect(rocmWorthDownloading({ ...io, platform: 'linux', canOpen: () => true })).toBe(true);
    expect(rocmWorthDownloading({ ...io, platform: 'linux', canOpen: () => false })).toBe(false);
    // Nothing on disk names a Windows Radeon's architecture.
    expect(rocmWorthDownloading({ ...io, platform: 'win32', canOpen: () => true })).toBe(false);
  });

  it('the release targets are the architectures the README and matrix name', () => {
    expect(ROCM_GFX_TARGETS).toEqual([
      'gfx1100',
      'gfx1101',
      'gfx1102',
      'gfx1103',
      'gfx1150',
      'gfx1151',
      'gfx1200',
      'gfx1201',
    ]);
  });
});

describe('rocmEngineEnv', () => {
  const binDir = join('n', 'win32-x64-rocm');
  const listDir = () => ['blas_lib_gfx1201.kpack', 'blas_lib_gfx1100.kpack', 'notes.txt'];

  it('names every bundled kernel pack, turns hipBLASLt off, and hides unsupported GPUs', () => {
    expect(rocmEngineEnv(binDir, [1], {}, listDir)).toEqual({
      ROCM_KPACK_PATH_PREFIX: [
        join(binDir, 'kpack', 'blas_lib_gfx1100.kpack'),
        join(binDir, 'kpack', 'blas_lib_gfx1201.kpack'),
      ].join(delimiter),
      ROCBLAS_USE_HIPBLASLT: '0',
      HIP_VISIBLE_DEVICES: '1',
    });
  });

  it("keeps an operator's own settings", () => {
    const env = rocmEngineEnv(
      binDir,
      [1],
      {
        ROCM_KPACK_PATH_PREFIX: '/opt/extra.kpack',
        ROCBLAS_USE_HIPBLASLT: '1',
        HIP_VISIBLE_DEVICES: '0',
      },
      listDir,
    );
    expect(env.ROCM_KPACK_PATH_PREFIX?.endsWith(`${delimiter}/opt/extra.kpack`)).toBe(true);
    expect(env.ROCBLAS_USE_HIPBLASLT).toBeUndefined();
    expect(env.HIP_VISIBLE_DEVICES).toBeUndefined();
  });
});

describe('checkRocmBuild', () => {
  const home = join('h');
  const binary = join('n', 'linux-x64-rocm', 'gezel-llama-server');
  const metadata = JSON.stringify({ backend: 'rocm', rocmTargets: ['gfx1201'] });

  function fakeIo(overrides: { listDevices?: () => string | null; now?: Date } = {}) {
    const files = new Map<string, string>([
      [join('n', 'linux-x64-rocm', 'gezel-llama-build.json'), metadata],
    ]);
    let probes = 0;
    return {
      files,
      probes: () => probes,
      io: {
        platform: 'linux' as const,
        canOpen: () => true,
        fingerprint: () => '100:200',
        listDir: (path: string) => {
          if (path.endsWith('nodes')) return ['1'];
          throw new Error('ENOENT');
        },
        readFile: (path: string) => {
          if (path.endsWith('properties')) return 'gfx_target_version 120001\n';
          const text = files.get(path);
          if (text === undefined) throw new Error('ENOENT');
          return text;
        },
        writeFile: (path: string, data: string) => void files.set(path, data),
        listDevices: () => {
          probes += 1;
          return overrides.listDevices ? overrides.listDevices() : MIXED_LOG;
        },
        now: () => overrides.now ?? new Date('2026-11-05T00:00:00Z'),
      },
    };
  }

  it('asks the build once and answers from the cache after', () => {
    const fake = fakeIo();
    expect(checkRocmBuild(home, binary, fake.io)).toMatchObject({
      blocker: null,
      visibleDevices: [1],
    });
    expect(checkRocmBuild(home, binary, fake.io)).toMatchObject({ visibleDevices: [1] });
    expect(fake.probes()).toBe(1);
    expect(fake.files.has(rocmDeviceCachePath(home))).toBe(true);
  });

  it('asks again when the build or the AMD GPUs change', () => {
    const fake = fakeIo();
    checkRocmBuild(home, binary, fake.io);
    checkRocmBuild(home, binary, { ...fake.io, fingerprint: () => '101:200' });
    expect(fake.probes()).toBe(2);
  });

  it('retries a failed probe after a day, not before', () => {
    const fake = fakeIo({ listDevices: () => null });
    expect(checkRocmBuild(home, binary, fake.io).blocker?.kind).toBe('probe-failed');
    checkRocmBuild(home, binary, { ...fake.io, now: () => new Date('2026-11-05T12:00:00Z') });
    expect(fake.probes()).toBe(1);
    checkRocmBuild(home, binary, { ...fake.io, now: () => new Date('2026-11-06T01:00:00Z') });
    expect(fake.probes()).toBe(2);
  });

  it('says so, without spawning, when Linux denies /dev/kfd', () => {
    const fake = fakeIo();
    const check = checkRocmBuild(home, binary, { ...fake.io, canOpen: () => false });
    expect(check.blocker?.kind).toBe('no-device-access');
    expect(fake.probes()).toBe(0);
  });

  // The supervisor and an embedded daemon run on Electron's main thread: they
  // probe asynchronously first, so the synchronous check reads the cache.
  it('probes without blocking, then answers the synchronous check from the cache', async () => {
    const fake = fakeIo();
    let asyncProbes = 0;
    const io = {
      ...fake.io,
      listDevicesAsync: async () => {
        asyncProbes += 1;
        return MIXED_LOG;
      },
    };
    expect(await checkRocmBuildAsync(home, binary, io)).toMatchObject({ visibleDevices: [1] });
    expect(checkRocmBuild(home, binary, io)).toMatchObject({ visibleDevices: [1] });
    expect(asyncProbes).toBe(1);
    expect(fake.probes()).toBe(0);
  });

  it.skipIf(process.platform === 'win32')(
    'runs the real probe as a child process and reads its output',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gezel-rocm-probe-'));
      try {
        const script = join(dir, 'gezel-llama-server');
        const printsDevices = `#!/bin/sh\ncat <<'EOF'\n${MIXED_LOG}\nEOF\n`;
        writeFileSync(script, printsDevices);
        chmodSync(script, 0o755);
        const fake = fakeIo();
        const io = { ...fake.io, listDevices: undefined, listDevicesAsync: undefined };
        expect(await checkRocmBuildAsync(home, script, io)).toMatchObject({ blocker: null });

        writeFileSync(script, '#!/bin/sh\nexit 3\n');
        const failed = await checkRocmBuildAsync(home, script, {
          ...io,
          fingerprint: () => 'changed',
        });
        expect(failed.blocker?.kind).toBe('probe-failed');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('records a failed asynchronous probe like a failed synchronous one', async () => {
    const fake = fakeIo();
    const check = await checkRocmBuildAsync(home, binary, {
      ...fake.io,
      listDevicesAsync: async () => null,
    });
    expect(check.blocker?.kind).toBe('probe-failed');
    expect(checkRocmBuild(home, binary, fake.io).blocker?.kind).toBe('probe-failed');
    expect(fake.probes()).toBe(0);
  });
});

describe('the ROCm blocker env', () => {
  it('round-trips and clears', () => {
    const env: NodeJS.ProcessEnv = {};
    const check = {
      blocker: { kind: 'no-supported-gpu' as const, detail: 'gfx1030' },
      devices: [],
      visibleDevices: null,
    };
    publishRocmCheck(check, env);
    expect(readRocmBlocker(env)).toEqual(check.blocker);
    publishRocmCheck(null, env);
    expect(env[LLAMA_ROCM_BLOCKER_ENV]).toBeUndefined();
    expect(
      readRocmBlocker({ [LLAMA_ROCM_BLOCKER_ENV]: '{"kind":"other","detail":"x"}' }),
    ).toBeNull();
  });
});
