import { describe, expect, it } from 'vitest';
import {
  type ServiceQueryExec,
  parseLaunchctlPrintState,
  parseScQueryState,
  parseSystemctlShowState,
  queryMachineServiceState,
} from './service-registration.js';

const SC_RUNNING = [
  'SERVICE_NAME: GezelService',
  '        TYPE               : 10  WIN32_OWN_PROCESS',
  '        STATE              : 4  RUNNING',
  '                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)',
  '        WIN32_EXIT_CODE    : 0  (0x0)',
].join('\r\n');

const SC_START_PENDING = SC_RUNNING.replace('4  RUNNING', '2  START_PENDING');
const SC_STOPPED = SC_RUNNING.replace('4  RUNNING', '1  STOPPED');

describe('parseScQueryState', () => {
  it('maps the standard states', () => {
    expect(parseScQueryState(SC_RUNNING)).toBe('running');
    expect(parseScQueryState(SC_START_PENDING)).toBe('start-pending');
    expect(parseScQueryState(SC_STOPPED)).toBe('stopped');
    expect(parseScQueryState(SC_RUNNING.replace('4  RUNNING', '3  STOP_PENDING'))).toBe('stopped');
    expect(parseScQueryState(SC_RUNNING.replace('4  RUNNING', '7  PAUSED'))).toBe('running');
  });

  it('survives a localized STATE label via the numeric code', () => {
    // German builds have shipped localized labels; the `: <n>  TOKEN`
    // shape is the stable part.
    const localized = SC_RUNNING.replace('STATE              :', 'STATUS             :');
    expect(parseScQueryState(localized)).toBe('running');
  });

  it('falls back to the state token when the numeric shape is absent', () => {
    expect(parseScQueryState('weird preamble\nSTATE: RUNNING')).toBe('running');
    expect(parseScQueryState('nothing recognizable')).toBe('unknown');
  });
});

describe('parseLaunchctlPrintState', () => {
  it('reads state = running', () => {
    expect(parseLaunchctlPrintState('system/com.bendyline.gezeld = {\n\tstate = running\n}')).toBe(
      'running',
    );
  });
  it('treats a loaded daemon without running state as stopped', () => {
    expect(parseLaunchctlPrintState('system/com.bendyline.gezeld = {\n\tstate = waiting\n}')).toBe(
      'stopped',
    );
    expect(parseLaunchctlPrintState('system/com.bendyline.gezeld = {}')).toBe('stopped');
  });
});

describe('parseSystemctlShowState', () => {
  it('maps LoadState/ActiveState combinations', () => {
    expect(parseSystemctlShowState('LoadState=loaded\nActiveState=active\n')).toBe('running');
    expect(parseSystemctlShowState('LoadState=loaded\nActiveState=activating\n')).toBe(
      'start-pending',
    );
    expect(parseSystemctlShowState('LoadState=loaded\nActiveState=inactive\n')).toBe('stopped');
    expect(parseSystemctlShowState('LoadState=loaded\nActiveState=failed\n')).toBe('stopped');
    expect(parseSystemctlShowState('LoadState=not-found\nActiveState=inactive\n')).toBe(
      'not-installed',
    );
  });
  it('returns unknown on unrecognizable output', () => {
    expect(parseSystemctlShowState('')).toBe('unknown');
  });
});

describe('queryMachineServiceState', () => {
  const execReturning =
    (stdout: string): ServiceQueryExec =>
    async () => ({ stdout, stderr: '' });

  it('queries sc.exe on win32', async () => {
    const state = await queryMachineServiceState({
      platform: 'win32',
      exec: execReturning(SC_RUNNING),
    });
    expect(state.status).toBe('running');
  });

  it('maps sc.exe exit 1060 to not-installed', async () => {
    const exec: ServiceQueryExec = async () => {
      const err = new Error('Command failed: sc.exe query GezelService') as Error & {
        code: number;
      };
      err.code = 1060;
      throw err;
    };
    const state = await queryMachineServiceState({ platform: 'win32', exec });
    expect(state.status).toBe('not-installed');
  });

  it('maps other sc.exe failures to unknown, never throwing', async () => {
    const exec: ServiceQueryExec = async () => {
      throw new Error('EACCES');
    };
    const state = await queryMachineServiceState({ platform: 'win32', exec });
    expect(state.status).toBe('unknown');
  });

  it('maps launchctl "Could not find service" to not-installed', async () => {
    const exec: ServiceQueryExec = async () => {
      throw new Error('Could not find service "com.bendyline.gezeld" in domain for system');
    };
    const state = await queryMachineServiceState({ platform: 'darwin', exec });
    expect(state.status).toBe('not-installed');
  });

  it('reads systemctl show on linux', async () => {
    const state = await queryMachineServiceState({
      platform: 'linux',
      exec: execReturning('LoadState=loaded\nActiveState=active\n'),
    });
    expect(state.status).toBe('running');
  });

  it('reports not-installed on unsupported platforms', async () => {
    const state = await queryMachineServiceState({ platform: 'freebsd' as NodeJS.Platform });
    expect(state.status).toBe('not-installed');
  });
});
