import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import {
  HARNESS_CLIENT_IDS,
  HARNESS_CLIENT_LABELS,
  HARNESS_NO_PROJECT,
  type HarnessBlock,
  type HarnessClientId,
  type HarnessConnection,
  type HarnessLaunchSpec,
  type HarnessToolsClientStatus,
  type HarnessToolsConfigUpdate,
  type HarnessToolsSetupRequest,
  type HarnessToolsStatusResponse,
  createLogger,
  parseHarnessAppId,
  resolveHarnessToolsConfig,
  resolveSecurityPolicy,
} from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import type { TokenStore } from '../http/token-store.js';
import { createMutationQueue } from '../local-harness/base.js';
import { detectClaudeBinary } from '../providers/anthropic-cli/binary.js';
import { detectCodexBinary, runTextProbe } from '../providers/codex-cli/binary.js';
import { discoverVSCodeProfiles, vscodeUserDir } from '../vscode-setup/profiles.js';
import {
  type HarnessClientAdapter,
  type HarnessClientContext,
  type VSCodeProfileTarget,
  claudeCodeAdapter,
  claudeDesktopAdapter,
  codexAdapter,
  cursorAdapter,
  readSetupRecord,
  removeSetupRecord,
  vscodeAdapter,
  writeSetupRecord,
} from './clients.js';
import { type HarnessLauncher, ensureHarnessLauncher, harnessLaunchSpec } from './launcher.js';

const log = createLogger('harness-tools');

const NO_NODE =
  'Gezel could not find Node.js to run its tools for other apps. Reinstalling Gezel puts it back.';
/** Settings polls status; finding `claude` or `codex` runs it, so a found answer is kept a minute. */
const BINARY_CACHE_MS = 60_000;

function cachedFor<T>(ms: number, load: () => Promise<T>): () => Promise<T> {
  let value: { at: number; result: Promise<T> } | null = null;
  return () => {
    if (!value || Date.now() - value.at > ms) {
      const result = load();
      value = { at: Date.now(), result };
      result.catch(() => {
        value = null;
      });
    }
    return value.result;
  };
}

const LOCKDOWN =
  "Gezel's security level keeps your work on this computer, so other apps cannot use Gezel's tools.";

export interface HarnessToolsManagerOptions {
  home: string;
  store: Pick<Store, 'readConfig' | 'writeConfig' | 'getProject'>;
  tokenStore: TokenStore;
  userHome?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Test seams. */
  run?: HarnessClientContext['run'];
  launcher?: () => Promise<HarnessLauncher>;
  claudeBinary?: () => Promise<string | null>;
  codexBinary?: () => Promise<string | null>;
  vscodeProfiles?: (ctx: HarnessClientContext) => Promise<VSCodeProfileTarget[]>;
}

/**
 * Settings → Integrations for Gezel's tools in other AI apps: which apps
 * have Gezel set up, the person's choices for all of them, the apps using
 * the tools right now, and the folders they were stopped in.
 */
export class HarnessToolsManager {
  private readonly opts: HarnessToolsManagerOptions;
  private readonly ctx: HarnessClientContext;
  private readonly adapters: Record<HarnessClientId, HarnessClientAdapter>;
  private readonly mutate = createMutationQueue();

  constructor(opts: HarnessToolsManagerOptions) {
    this.opts = opts;
    this.ctx = {
      home: opts.home,
      userHome: opts.userHome ?? homedir(),
      env: opts.env ?? process.env,
      platform: opts.platform ?? process.platform,
      run: opts.run ?? ((command, args) => runTextProbe(command, args, 30_000)),
    };
    const claude = cachedFor(BINARY_CACHE_MS, async () => {
      if (opts.claudeBinary) return opts.claudeBinary();
      const config = await opts.store.readConfig();
      const found = await detectClaudeBinary({
        ...(config.anthropicCli?.binaryPath ? { override: config.anthropicCli.binaryPath } : {}),
        env: this.ctx.env,
      });
      return found.installed ? (found.path ?? null) : null;
    });
    const codex = cachedFor(BINARY_CACHE_MS, async () => {
      if (opts.codexBinary) return opts.codexBinary();
      const config = await opts.store.readConfig();
      const found = await detectCodexBinary({
        ...(config.codexCli?.binaryPath ? { override: config.codexCli.binaryPath } : {}),
        env: this.ctx.env,
      });
      return found.installed ? (found.path ?? null) : null;
    });
    this.adapters = {
      'claude-code': claudeCodeAdapter(claude),
      'claude-desktop': claudeDesktopAdapter(),
      codex: codexAdapter(codex),
      cursor: cursorAdapter(),
      vscode: vscodeAdapter(opts.vscodeProfiles ?? defaultVSCodeProfiles),
    };
  }

  private launcher(): Promise<HarnessLauncher> {
    return this.opts.launcher
      ? this.opts.launcher()
      : ensureHarnessLauncher({ home: this.opts.home });
  }

  /** The entry an app would get now. VS Code and Cursor resolve the workspace folder themselves. */
  private expected(
    launcher: HarnessLauncher,
    client: HarnessClientId,
    projectId?: string,
  ): HarnessLaunchSpec | null {
    return harnessLaunchSpec(launcher, client, {
      ...(projectId ? { projectId } : {}),
      workspaceFolderVariable: client === 'vscode' || client === 'cursor',
    });
  }

  async status(): Promise<HarnessToolsStatusResponse> {
    const fullConfig = await this.opts.store.readConfig();
    const config = resolveHarnessToolsConfig(fullConfig);
    const launcher = await this.launcher();
    const clients = await Promise.all(
      HARNESS_CLIENT_IDS.map((c) => this.clientStatus(c, launcher)),
    );
    const unavailableReason = !resolveSecurityPolicy(fullConfig).allowExternalChat
      ? LOCKDOWN
      : launcher.node
        ? undefined
        : NO_NODE;
    return {
      config: {
        enabled: config.enabled,
        memory: config.memory,
        images: config.images,
        newFolders: config.newFolders,
      },
      ...(unavailableReason ? { unavailableReason } : {}),
      clients,
      connections: await this.connections(),
      blocked: await Promise.all(
        config.blocked.map(async (block) => ({
          ...block,
          label: HARNESS_CLIENT_LABELS[block.client],
          ...(await this.projectName(block.projectId)),
        })),
      ),
    };
  }

  async clientStatus(
    client: HarnessClientId,
    launcher?: HarnessLauncher,
  ): Promise<HarnessToolsClientStatus> {
    const record = await readSetupRecord(this.opts.home, client);
    const resolved = launcher ?? (await this.launcher());
    const status = await this.adapters[client].inspect({
      ctx: this.ctx,
      expected: this.expected(resolved, client, record?.projectId),
      record,
    });
    return { ...status, ...(record?.projectId ? { projectId: record.projectId } : {}) };
  }

  configure(
    client: HarnessClientId,
    req: HarnessToolsSetupRequest,
  ): Promise<HarnessToolsClientStatus> {
    return this.mutate(async () => {
      const launcher = await this.launcher();
      const projectId = client === 'claude-desktop' ? req.projectId : undefined;
      if (projectId && !(await this.opts.store.getProject(projectId))) {
        throw Object.assign(new Error(`project ${projectId} was not found`), { status: 404 });
      }
      const expected = this.expected(launcher, client, projectId);
      if (!expected) throw new Error(NO_NODE);
      const record = await readSetupRecord(this.opts.home, client);
      await this.adapters[client].configure({
        ctx: this.ctx,
        expected,
        record,
        replaceExisting: req.replaceExisting === true,
        ...(req.profileId ? { profileId: req.profileId } : {}),
      });
      const status = await this.adapters[client].inspect({
        ctx: this.ctx,
        expected,
        record,
        ...(req.profileId ? { profileId: req.profileId } : {}),
      });
      await writeSetupRecord(this.opts.home, {
        version: 1,
        client,
        spec: expected,
        ...(status.configPath ? { configPath: status.configPath } : {}),
        ...(projectId ? { projectId } : {}),
        ...(status.profileId ? { profileId: status.profileId } : {}),
        at: new Date().toISOString(),
      });
      // A different project for Claude Desktop means its old token no longer applies.
      this.opts.tokenStore.revokeHarness((r) => r.appId.startsWith(`harness:${client}:`));
      return this.clientStatus(client, launcher);
    });
  }

  remove(client: HarnessClientId): Promise<HarnessToolsClientStatus> {
    return this.mutate(async () => {
      const launcher = await this.launcher();
      const record = await readSetupRecord(this.opts.home, client);
      await this.adapters[client].remove({
        ctx: this.ctx,
        expected: this.expected(launcher, client, record?.projectId),
        record,
      });
      await removeSetupRecord(this.opts.home, client);
      this.opts.tokenStore.revokeHarness((r) => r.appId.startsWith(`harness:${client}:`));
      return this.clientStatus(client, launcher);
    });
  }

  /** The person's choices for every app. Tokens minted under the old ones are revoked. */
  updateConfig(update: HarnessToolsConfigUpdate): Promise<HarnessToolsStatusResponse> {
    return this.mutate(async () => {
      const current = (await this.opts.store.readConfig()).harnessTools ?? {};
      await this.opts.store.writeConfig({ harnessTools: { ...current, ...update } });
      // Each app re-trades on its next call and so learns the new choices.
      this.opts.tokenStore.revokeHarness(() => true);
      return this.status();
    });
  }

  /** "Stop for this folder": block the app in that project until the person undoes it. */
  stopConnection(appId: string): Promise<HarnessToolsStatusResponse> {
    return this.mutate(async () => {
      const parsed = parseHarnessAppId(appId);
      if (!parsed) throw Object.assign(new Error('not a harness connection'), { status: 400 });
      await this.setBlocked(
        { client: parsed.client, projectId: parsed.projectId ?? HARNESS_NO_PROJECT },
        true,
      );
      this.opts.tokenStore.revokeHarness((r) => r.appId === appId);
      return this.status();
    });
  }

  unblock(block: HarnessBlock): Promise<HarnessToolsStatusResponse> {
    return this.mutate(async () => {
      await this.setBlocked(block, false);
      return this.status();
    });
  }

  /** The command an app's MCP config should run. The VS Code extension asks for it. */
  async launchSpec(client: HarnessClientId, projectId?: string): Promise<HarnessLaunchSpec | null> {
    return harnessLaunchSpec(await this.launcher(), client, projectId ? { projectId } : {});
  }

  /**
   * At start: point the launcher at this install, and quietly repair any file
   * entry Gezel wrote that still names an old launch command. Apps configured
   * through their own command line wait for Repair, so starting Gezel never
   * runs another app's binary.
   */
  async reconcile(): Promise<void> {
    const launcher = await this.launcher().catch((err: unknown) => {
      log.warn(`launcher not written: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
    if (!launcher?.node) return;
    for (const client of ['cursor', 'claude-desktop', 'vscode'] as const) {
      const status = await this.clientStatus(client, launcher).catch(() => null);
      if (status?.state !== 'update-needed') continue;
      await this.configure(client, {
        ...(status.projectId ? { projectId: status.projectId } : {}),
        ...(status.profileId ? { profileId: status.profileId } : {}),
      }).catch((err: unknown) => {
        log.warn(`${client} repair failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  private async setBlocked(block: HarnessBlock, blocked: boolean): Promise<void> {
    const current = (await this.opts.store.readConfig()).harnessTools ?? {};
    const others = (current.blocked ?? []).filter(
      (b) => !(b.client === block.client && b.projectId === block.projectId),
    );
    await this.opts.store.writeConfig({
      harnessTools: { ...current, blocked: blocked ? [...others, block] : others },
    });
  }

  private async connections(): Promise<HarnessConnection[]> {
    const records = this.opts.tokenStore.list().filter((r) => r.scopes.includes('harness'));
    const out: HarnessConnection[] = [];
    for (const record of records) {
      const parsed = parseHarnessAppId(record.appId);
      if (!parsed) continue;
      out.push({
        appId: record.appId,
        client: parsed.client,
        label: HARNESS_CLIENT_LABELS[parsed.client],
        projectId: parsed.projectId,
        ...(parsed.projectId ? await this.projectName(parsed.projectId) : {}),
        ...(record.folder ? { folder: record.folder } : {}),
        createdAt: record.createdAt,
        lastUsedAt: record.lastUsedAt,
      });
    }
    return out.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  private async projectName(projectId: string): Promise<{ projectName?: string }> {
    if (projectId === HARNESS_NO_PROJECT) return {};
    const project = await this.opts.store.getProject(projectId).catch(() => null);
    return project ? { projectName: project.name } : {};
  }
}

/** Every VS Code (and Insiders) profile folder on this computer, default first. */
async function defaultVSCodeProfiles(ctx: HarnessClientContext): Promise<VSCodeProfileTarget[]> {
  const out: VSCodeProfileTarget[] = [];
  for (const product of ['code', 'code-insiders'] as const) {
    const userDir = vscodeUserDir({
      product,
      env: ctx.env,
      platform: ctx.platform,
      home: ctx.userHome,
    });
    if (!existsSync(userDir)) continue;
    const profiles = await discoverVSCodeProfiles({ product, userDir }).catch(() => []);
    for (const profile of profiles) {
      out.push({
        id: profile.id,
        label: product === 'code-insiders' ? `${profile.label} (Insiders)` : profile.label,
        dir: dirname(profile.configPath),
      });
    }
  }
  return out;
}
