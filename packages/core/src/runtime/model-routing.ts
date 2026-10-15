import type { PortableInference } from '../mobile/inference.js';
import { parseRemoteModelId } from '../remote/index.js';
import type { GezelConfig } from '../schemas/api.js';
import { type ProviderName, ProviderNameSchema } from '../schemas/gezel.js';
import {
  type MobileModelInventory,
  type MobileProvider,
  type MobileProviderId,
  MobileProviderIdSchema,
} from '../schemas/mobile-provider.js';
import type { ChatSession } from '../schemas/session.js';
import { HttpStatusError as ProductError } from './http/errors.js';
import { pickLocalProvider } from './local-provider.js';
import {
  type PortablePairedServer,
  type PortableRemoteServers,
  RemoteServerUnreachableError,
} from './remote-servers.js';

interface PortableModelRoutingHost {
  inference: Pick<PortableInference, 'models'>;
  providers(): Promise<MobileProvider[]>;
  remotes: Pick<PortableRemoteServers, 'server' | 'check' | 'admit'>;
}

/**
 * Where a turn runs. `notice` is set when a conversation on a paired server's
 * model runs here instead, because the server isn't reachable.
 */
export type PortableTurnRoute =
  | { kind: 'local'; providerId: MobileProviderId; provider: MobileProvider; notice?: string }
  | {
      kind: 'remote';
      providerId: 'remote';
      server: PortablePairedServer;
      /** `remote:<remoteId>/<the server's id>`, as the conversation stores it. */
      modelId: string;
      serverModel: string;
      contextWindow: number;
      parameterSize?: string;
    };

/** A server's window when it is there but could not say in time, and never said before. */
const REMOTE_FALLBACK_CONTEXT = 16_384;
/** How recent a server's last answer must be for a turn to go to it unprobed. */
const TURN_FRESH_MS = 15_000;

/** A server's `<provider>:<model>` id, split; an unknown provider reads as `remote`. */
export function serverModelParts(id: string): { providerName: ProviderName; modelId: string } {
  const colon = id.indexOf(':');
  const provider = ProviderNameSchema.safeParse(colon > 0 ? id.slice(0, colon) : '');
  return provider.success
    ? { providerName: provider.data, modelId: id.slice(colon + 1) }
    : { providerName: 'remote', modelId: id };
}

/**
 * The provider and model a new conversation with this gezel starts on: a
 * paired server's model when the gezel or this device's default names one
 * it is still paired with, otherwise this device's own.
 */
export async function portableSessionModel(
  host: PortableModelRoutingHost,
  gezel: { provider?: ProviderName; parsed: { frontmatter: { model?: string } } } | null,
  config: GezelConfig,
): Promise<{ providerName: ProviderName; model: string; inventory?: MobileModelInventory }> {
  const requested = gezel?.provider ?? config.provider ?? 'llama-cpp';
  const pinned = gezel?.parsed.frontmatter.model;
  if (requested === 'remote') {
    const model = pinned && parseRemoteModelId(pinned) ? pinned : config.defaultModel?.remote;
    const target = model ? parseRemoteModelId(model) : null;
    if (model && target && (await host.remotes.server(target.remoteId)))
      return { providerName: 'remote', model };
  }
  const providerName =
    requested === 'remote'
      ? ((await pickLocalProvider(host))?.providerId ?? 'llama-cpp')
      : MobileProviderIdSchema.parse(requested);
  const inventory = providerName === 'llama-cpp' ? await host.inference.models?.() : undefined;
  const model =
    (requested === 'remote' ? undefined : pinned) ?? inventory?.selectedModelId ?? providerName;
  return { providerName, model, ...(inventory ? { inventory } : {}) };
}

/**
 * Where this turn runs. A conversation on a paired server's model runs
 * there while the server answers. When it doesn't (it is asleep, or this
 * device left its network), the turn runs on this device's own model and
 * says so, and the conversation goes back to the server once it answers.
 */
export async function portableTurnRoute(
  host: PortableModelRoutingHost,
  session: ChatSession,
  config: GezelConfig,
): Promise<PortableTurnRoute> {
  if (session.providerName !== 'remote') {
    const providerId = MobileProviderIdSchema.parse(session.providerName);
    const provider = (await host.providers()).find((item) => item.id === providerId);
    if (!provider || provider.availability !== 'available')
      throw new ProductError(
        provider?.reason ?? 'Choose an available on-device model in Settings.',
        409,
      );
    return { kind: 'local', providerId, provider };
  }
  const modelId = session.model ?? config.defaultModel?.remote ?? '';
  const target = parseRemoteModelId(modelId);
  const server = target ? await host.remotes.server(target.remoteId) : null;
  if (!target || !server)
    throw new ProductError(
      'The device this conversation ran on is no longer connected. Connect it again in Settings → Artificial Intelligence, or start a conversation with another model.',
      409,
    );
  // A turn trusts a recent answer less than a listing does: a phone that
  // just left the network should not wait on a server it can't reach.
  if ((await host.remotes.check(server.remoteId, TURN_FRESH_MS)) === 'online') {
    try {
      const known = server.knownModels?.find((model) => model.id === modelId);
      const contextWindow =
        (await host.remotes.admit(server, target.modelId)) ??
        known?.contextWindow ??
        REMOTE_FALLBACK_CONTEXT;
      return {
        kind: 'remote',
        providerId: 'remote',
        server,
        modelId,
        serverModel: target.modelId,
        contextWindow,
        ...(known?.parameterSize ? { parameterSize: known.parameterSize } : {}),
      };
    } catch (error) {
      if (!(error instanceof RemoteServerUnreachableError))
        throw new ProductError(error instanceof Error ? error.message : String(error), 409);
    }
  }
  const fallback = await pickLocalProvider(host);
  if (!fallback)
    throw new ProductError(
      `${server.displayName} isn't reachable right now, and this device has no model of its own ready. Join its network again, or set up a model on this device in Settings → Artificial Intelligence.`,
      409,
    );
  return {
    kind: 'local',
    ...fallback,
    notice: `${server.displayName} isn't reachable right now, so this reply came from this device's own model.`,
  };
}
