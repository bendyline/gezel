import { resolveSocialMode } from '../character/index.js';
import {
  type GrowthStep,
  acceptedGrowthState,
  declinedGrowthState,
  growthResponse,
  levelUpTrait,
  nudgedTemperatureTuning,
  pendingProposal,
  retiredTraitState,
} from '../growth/level-up.js';
import { createLogger } from '../log.js';
import type { PortableInference } from '../mobile/inference.js';
import type { GezelGrowthResponse } from '../schemas/api.js';
import type { ChatEvent, ChatMessage, GezelTrait } from '../schemas/gezel.js';
import type { ChatSession } from '../schemas/session.js';
import type { ChatEventBus } from './chat-events.js';
import type { PortableGrowth } from './growth-engine.js';
import { HttpStatusError as ProductError } from './http/errors.js';
import type { ProviderQueue } from './provider-queue.js';
import type { PortableStore } from './store.js';
import { type PortableTransformTarget, portablePromptCompletion } from './transform.js';

const log = createLogger('portable-tasks');

/**
 * What the product service lends gezel growth on the phone: the growth
 * routes, the Klerk's background completion for proposals, and the
 * level-up announcement in the gezel's latest conversation.
 */
export interface PortableGrowthHost {
  store: PortableStore;
  growth: PortableGrowth;
  engine: ProviderQueue;
  inference: PortableInference;
  eventBus: ChatEventBus;
  /** Background growth completions in flight, stopped when the app suspends or stops all. */
  growthCalls: Set<AbortController>;
  /** Conversations with a turn waiting or running. */
  turns: ReadonlyMap<string, unknown>;
  emit(session: Pick<ChatSession, 'id' | 'gezelId' | 'projectId'>, event: ChatEvent): void;
  resolveKlerkModel(signal: AbortSignal): Promise<PortableTransformTarget>;
}

/**
 * The growth sheet and the level-up consent loop, the same routes and the
 * same state transitions as the desktop (core/src/growth/level-up.ts).
 * Every mutation re-reads growth.json under the gezel's growth lock.
 */
export async function handlePortableGrowthRoute(
  host: Pick<PortableGrowthHost, 'store' | 'growth'>,
  gezelId: string,
  method: string,
  body: Record<string, unknown>,
  child?: string,
  traitId?: string,
): Promise<GezelGrowthResponse> {
  const gezel = await host.store.getGezel(gezelId);
  if (!gezel) throw new ProductError(`gezel ${gezelId} not found`, 404);
  const payload = async () => {
    const [state, current] = await Promise.all([
      host.store.readGezelGrowth(gezelId),
      host.store.getGezel(gezelId),
    ]);
    return growthResponse(state, current?.parsed.frontmatter.traits ?? []);
  };
  const step = <T>(result: GrowthStep<T>): T => {
    if (!result.ok) throw new ProductError(result.error, result.status);
    return result.value;
  };
  if (!child && method === 'GET') {
    const response = await payload();
    const computedAt = response.state.lastComputedAt
      ? Date.parse(response.state.lastComputedAt)
      : 0;
    // A stale sheet refreshes its signals in the background, never offering a level-up.
    if (Date.now() - computedAt > 6 * 60 * 60 * 1000)
      void host.growth
        .refresh(gezelId, { allowKlerk: false, createPending: false })
        .catch((error) => log.warn(`growth refresh failed for ${gezelId}`, error));
    return response;
  }
  if (child === 'refresh' && method === 'POST') {
    await host.growth.refresh(gezelId, { allowKlerk: true });
    return payload();
  }
  if (child === 'accept' && method === 'POST')
    return host.growth.runExclusive(gezelId, async () => {
      const state = await host.store.readGezelGrowth(gezelId);
      const { pending, proposal } = step(
        pendingProposal(state, typeof body.proposalId === 'string' ? body.proposalId : undefined),
      );
      const now = new Date().toISOString();
      const fm =
        (await host.store.getGezel(gezelId))?.parsed.frontmatter ?? gezel.parsed.frontmatter;
      let adopted: GezelTrait | undefined;
      if (proposal.kind === 'trait') {
        const traits = fm.traits ?? [];
        if (traits.length >= 8)
          throw new ProductError('This gezel already has 8 traits; retire one first.', 409);
        adopted = levelUpTrait(proposal, now);
        await host.store.updateGezelSettings(gezelId, { traits: [...traits, adopted] });
      } else if (proposal.kind === 'tuning') {
        await host.store.updateGezelSettings(
          gezelId,
          proposal.action.type === 'profile'
            ? { tuningProfile: proposal.action.profile }
            : { tuning: nudgedTemperatureTuning(fm.tuning, proposal.action.delta).tuning },
        );
      }
      try {
        await host.store.writeGezelGrowth(
          gezelId,
          acceptedGrowthState(state, pending, proposal, now, adopted),
        );
      } catch (error) {
        // A trait that landed without its growth record would invite a second payout.
        if (adopted)
          await host.store
            .updateGezelSettings(gezelId, { traits: fm.traits ?? [] })
            .catch(() => {});
        throw error;
      }
      return payload();
    });
  if (child === 'decline' && method === 'POST')
    return host.growth.runExclusive(gezelId, async () => {
      const state = await host.store.readGezelGrowth(gezelId);
      const proposalId = typeof body.proposalId === 'string' ? body.proposalId : undefined;
      await host.store.writeGezelGrowth(
        gezelId,
        step(declinedGrowthState(state, proposalId, new Date().toISOString())),
      );
      return payload();
    });
  if (child === 'traits' && traitId && method === 'DELETE')
    return host.growth.runExclusive(gezelId, async () => {
      const traits = (await host.store.getGezel(gezelId))?.parsed.frontmatter.traits ?? [];
      if (!traits.some((trait) => trait.id === traitId))
        throw new ProductError(`no trait ${traitId}`, 404);
      await host.store.updateGezelSettings(gezelId, {
        traits: traits.filter((trait) => trait.id !== traitId),
      });
      const state = await host.store.readGezelGrowth(gezelId);
      await host.store.writeGezelGrowth(
        gezelId,
        retiredTraitState(state, traitId, new Date().toISOString()),
      );
      return payload();
    });
  throw new ProductError(`This growth operation is not available: ${method} ${child ?? ''}`, 501);
}

/**
 * A growth proposal's model call: deferrable housekeeping in the background
 * lane, so it waits for a quiet engine and never holds up a person's turn.
 */
export async function portableGrowthCompletion(
  host: Pick<PortableGrowthHost, 'engine' | 'inference' | 'growthCalls' | 'resolveKlerkModel'>,
  prompt: string,
): Promise<string> {
  const controller = new AbortController();
  host.growthCalls.add(controller);
  try {
    const release = await host.engine.acquire({
      lane: 'background',
      ambient: true,
      actorLabel: 'Klerk',
      job: 'Klerk · growth',
      signal: controller.signal,
    });
    try {
      return await portablePromptCompletion(host.inference, prompt, {
        resolveKlerk: (signal) => host.resolveKlerkModel(signal),
        signal: controller.signal,
      });
    } finally {
      release();
    }
  } finally {
    host.growthCalls.delete(controller);
  }
}

/**
 * Tell the person in the gezel's latest conversation, the desktop's
 * wording. Held while social mode is off, and skipped while that
 * conversation has a turn running so the note never races its reply.
 */
export async function announcePortableGrowth(
  host: Pick<PortableGrowthHost, 'store' | 'turns' | 'emit' | 'eventBus'>,
  gezelId: string,
  toLevel: number,
): Promise<void> {
  if (!resolveSocialMode(await host.store.readConfig(), 'phone')) return;
  const latest = (await host.store.listSessions({ gezelId }))
    .filter((session) => !session.archived)
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
  if (!latest || host.turns.has(latest.id)) return;
  const gezel = await host.store.getGezel(gezelId);
  const at = new Date().toISOString();
  const message: ChatMessage = {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: `I just reached level ${toLevel}! I have growth choices waiting — open my Growth tab to pick one.`,
    at,
    synthetic: 'growth-announcement',
  };
  const written = await host.store.mutateSession(gezelId, latest.id, (session) => {
    session.messages.push(message);
    session.lastActivityAt = at;
  });
  if (!written) return;
  host.emit({ id: latest.id, gezelId, projectId: latest.projectId }, { type: 'complete', message });
  host.eventBus.publishGlobalEvent({
    type: 'growth_level_up',
    gezelId,
    gezelName: gezel?.name ?? gezelId,
    toLevel,
  });
}
