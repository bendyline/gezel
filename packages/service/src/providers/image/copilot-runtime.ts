import { pathToFileURL } from 'node:url';
import { resolveInstalledSystemLibrary } from '../../system-toolsets/resolve.js';
import { resolveCopilotCliPath } from '../copilot-cli.js';

export const COPILOT_IMAGE_UPDATE =
  'Update GitHub Copilot in Settings → GitHub Copilot to use image generation. If you installed the CLI yourself, update that installation too.';

export interface CopilotImageModel {
  id: string;
  name: string;
  isDefault: boolean;
  availability: 'available' | 'unavailable';
  supportedOperations: Array<'generate' | 'edit'>;
}

export interface CopilotImageSession {
  rpc: {
    tools: {
      initializeAndValidate(): Promise<unknown>;
      execute(request: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
    };
  };
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface CopilotImageClient {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  getAuthStatus(): Promise<{ isAuthenticated: boolean }>;
  rpc: {
    models: {
      list(request: { gitHubToken?: string }): Promise<{ imageModels?: CopilotImageModel[] }>;
    };
  };
  createSession(config: Record<string, unknown>): Promise<CopilotImageSession>;
}

export interface CopilotImageRuntimeOptions {
  home: string;
  githubToken?: string | undefined;
  env?: NodeJS.ProcessEnv;
}

export async function createCopilotImageClient(
  opts: CopilotImageRuntimeOptions,
): Promise<CopilotImageClient> {
  const installed = await resolveInstalledSystemLibrary(opts.home, '@github/copilot-sdk', {
    withEntry: true,
  });
  const root = await resolveInstalledSystemLibrary(opts.home, '@github/copilot-sdk');
  let mod: unknown;
  try {
    mod = installed
      ? await import(pathToFileURL(installed.path).href)
      : await import('@github/copilot-sdk');
  } catch {
    throw new CopilotImageSetupError(
      'Install or repair GitHub Copilot in Settings → GitHub Copilot, then sign in.',
    );
  }
  const env = opts.env ?? process.env;
  const cli = resolveCopilotCliPath({ installRoot: root?.path ?? null, env });
  const definedEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const { CopilotClient } = mod as {
    CopilotClient: new (config: Record<string, unknown>) => CopilotImageClient;
  };
  return new CopilotClient({
    ...(opts.githubToken ? { gitHubToken: opts.githubToken } : {}),
    env: { ...definedEnv, ...(cli ? { COPILOT_CLI_PATH: cli.path } : {}) },
  });
}

export class CopilotImageSetupError extends Error {
  readonly isActionable = true;
}

export async function copilotImageModel(
  client: CopilotImageClient,
  githubToken?: string,
): Promise<CopilotImageModel> {
  if (!(await client.getAuthStatus()).isAuthenticated) {
    throw new CopilotImageSetupError('Sign in to GitHub Copilot to generate images.');
  }
  if (!client.rpc?.models?.list) throw new CopilotImageSetupError(COPILOT_IMAGE_UPDATE);
  const { imageModels } = await client.rpc.models.list(
    githubToken ? { gitHubToken: githubToken } : {},
  );
  if (!imageModels) throw new CopilotImageSetupError(COPILOT_IMAGE_UPDATE);
  const model = imageModels.find((m) => m.isDefault);
  if (!model || model.availability !== 'available' || model.supportedOperations.length === 0) {
    throw new CopilotImageSetupError(
      'Image generation is not available for this GitHub Copilot account. Check your account or organization’s Copilot access.',
    );
  }
  return model;
}
