import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  LIBREOFFICE_EXTENSION_ID,
  type LibreOfficeHostReport,
  type LibreOfficeSetupStatusResponse,
} from '@bendyline/gezel';
import {
  SecurityStateCorruptionError,
  readSecurityJson,
  writeSecurityJson,
} from '../fs/security-json.js';
import { HarnessSetupError, createMutationQueue, ensurePrivateDir } from '../local-harness/base.js';
import { type LibreOfficeDetection, detectLibreOffice } from './detect.js';

/**
 * LibreOffice integration: the daemon knows where the `.oxt` this build
 * ships lives and what the desktop app last reported; the desktop app runs
 * `unopkg` in the user's context. No listener and no certificate: the
 * extension is a native process that discovers the daemon from
 * `runtime/port` + `runtime/cert.pem` and asks for a grant like the CLI.
 */

const STATE_VERSION = 1;

interface SetupState {
  version: 1;
  /** Digest of the .oxt the desktop app was asked to install. */
  oxtSha256: string;
  installed: boolean | null;
  reportedAt?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export class LibreOfficeSetupError extends HarnessSetupError {
  constructor(code: string, message: string, status: 400 | 404 | 409 | 500 = 409) {
    super(code, message, status);
    this.name = 'LibreOfficeSetupError';
  }
}

export interface LibreOfficeSetupManager {
  status(): Promise<LibreOfficeSetupStatusResponse>;
  configure(): Promise<LibreOfficeSetupStatusResponse>;
  recordHostReport(report: LibreOfficeHostReport): Promise<LibreOfficeSetupStatusResponse>;
  remove(): Promise<LibreOfficeSetupStatusResponse>;
}

export interface CreateLibreOfficeSetupManagerOptions {
  home: string;
  /** Path of the `.oxt` this build ships, if any. */
  oxtPath: () => string | undefined;
  detect?: () => Promise<LibreOfficeDetection>;
  now?: () => Date;
}

async function sha256OfFile(path: string): Promise<string | undefined> {
  try {
    return createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  } catch {
    return undefined;
  }
}

export function createLibreOfficeSetupManager(
  opts: CreateLibreOfficeSetupManagerOptions,
): LibreOfficeSetupManager {
  const integrationDir = join(opts.home, 'integrations', 'libreoffice');
  const statePath = join(integrationDir, 'setup.json');
  const now = opts.now ?? (() => new Date());
  const detect = opts.detect ?? (() => detectLibreOffice());
  const serialize = createMutationQueue();

  const readState = () => readSecurityJson(statePath, 'LibreOffice setup', decodeSetupState);
  const writeState = (state: SetupState) =>
    writeSecurityJson(statePath, `${JSON.stringify(state, null, 2)}\n`);

  async function buildStatus(): Promise<LibreOfficeSetupStatusResponse> {
    const detection = await detect().catch(() => ({}) as LibreOfficeDetection);
    const oxtPath = opts.oxtPath();
    const oxtSha256 = oxtPath ? await sha256OfFile(oxtPath) : undefined;
    const base = {
      libreofficeInstalled: Boolean(detection.sofficePath || detection.unopkgPath),
      ...(detection.sofficePath ? { sofficePath: detection.sofficePath } : {}),
      ...(detection.unopkgPath ? { unopkgPath: detection.unopkgPath } : {}),
      ...(detection.version ? { version: detection.version } : {}),
      ...(oxtPath && oxtSha256 ? { oxtPath, oxtSha256 } : {}),
      extensionId: LIBREOFFICE_EXTENSION_ID,
      canConfigure: Boolean(oxtSha256 && detection.unopkgPath),
    };
    let state: SetupState | null;
    try {
      state = await readState();
    } catch (err) {
      if (!(err instanceof SecurityStateCorruptionError)) throw err;
      return {
        ...base,
        state: 'conflict',
        reasons: ['The LibreOffice setup record is damaged. Remove it and install again.'],
        installed: null,
        canRemove: true,
      };
    }
    if (!oxtSha256) {
      return {
        ...base,
        state: 'unavailable',
        reasons: [],
        message: 'This Gezel build does not include the LibreOffice extension.',
        installed: state?.installed ?? null,
        canRemove: state !== null,
      };
    }
    if (!state) {
      return {
        ...base,
        state: detection.unopkgPath ? 'not-configured' : 'unavailable',
        reasons: [],
        ...(detection.unopkgPath ? {} : { message: 'LibreOffice was not found on this computer.' }),
        installed: null,
        canRemove: false,
      };
    }
    const reasons: string[] = [];
    if (state.installed === false) {
      reasons.push(
        state.error
          ? `The extension is not installed: ${state.error}`
          : 'The extension is not installed.',
      );
    } else if (state.installed === null) {
      reasons.push('Open the Gezel desktop app to install the extension.');
    }
    if (state.installed && state.oxtSha256 !== oxtSha256) {
      reasons.push('A newer Gezel extension for LibreOffice is ready to install.');
    }
    return {
      ...base,
      state: reasons.length > 0 ? 'update-needed' : 'configured',
      reasons,
      installed: state.installed,
      ...(state.error ? { error: state.error } : {}),
      ...(state.reportedAt ? { reportedAt: state.reportedAt } : {}),
      canRemove: true,
    };
  }

  return {
    status: () => buildStatus(),
    configure: () =>
      serialize(async () => {
        const oxtPath = opts.oxtPath();
        const oxtSha256 = oxtPath ? await sha256OfFile(oxtPath) : undefined;
        if (!oxtSha256) {
          throw new LibreOfficeSetupError(
            'libreoffice_extension_missing',
            'This Gezel build does not include the LibreOffice extension.',
          );
        }
        await ensurePrivateDir(integrationDir);
        const prior = await readState().catch(() => null);
        const stamp = now().toISOString();
        await writeState({
          version: STATE_VERSION,
          oxtSha256,
          installed: prior && prior.oxtSha256 === oxtSha256 ? prior.installed : null,
          createdAt: prior?.createdAt ?? stamp,
          updatedAt: stamp,
        });
        return buildStatus();
      }),
    recordHostReport: (report) =>
      serialize(async () => {
        const state = await readState();
        if (!state) {
          throw new LibreOfficeSetupError(
            'libreoffice_not_configured',
            'LibreOffice is not set up.',
            404,
          );
        }
        const stamp = now().toISOString();
        const oxtPath = opts.oxtPath();
        const current = oxtPath ? await sha256OfFile(oxtPath) : undefined;
        await writeState({
          ...state,
          // An install reports the .oxt it just installed: this build's.
          ...(report.installed && current ? { oxtSha256: current } : {}),
          installed: report.installed,
          reportedAt: stamp,
          ...(report.error ? { error: report.error } : { error: undefined }),
          updatedAt: stamp,
        });
        return buildStatus();
      }),
    remove: () =>
      serialize(async () => {
        await rm(integrationDir, { recursive: true, force: true });
        return buildStatus();
      }),
  };
}

function decodeSetupState(raw: string): SetupState {
  const parsed = JSON.parse(raw) as Partial<SetupState>;
  if (
    parsed.version !== STATE_VERSION ||
    typeof parsed.oxtSha256 !== 'string' ||
    !(parsed.installed === null || typeof parsed.installed === 'boolean') ||
    typeof parsed.createdAt !== 'string' ||
    typeof parsed.updatedAt !== 'string'
  ) {
    throw new Error('invalid LibreOffice setup record');
  }
  return parsed as SetupState;
}
