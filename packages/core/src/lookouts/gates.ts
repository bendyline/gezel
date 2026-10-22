import type { LookoutAction } from '../schemas/lookout.js';

/**
 * Which of a fired lookout's actions may run right now. Every action is
 * judged separately — a held email never silences the alarm — and a held
 * action carries the plain-language reason the firing log shows.
 *
 * Install-wide ceilings sit beneath the per-lookout limits so that no set of
 * lookouts, however configured, can turn a camera into a mail cannon.
 */

export const LOOKOUT_DAILY_CEILINGS = Object.freeze({
  firings: 60,
  /** Push and email, across every lookout on the install. */
  outbound: 30,
  /** Ask-a-gezel and run-a-craftbook, across every lookout on the install. */
  followUps: 10,
});

export interface LookoutGateContext {
  /** `isTaskWorkAllowed` — engagement is Proactive or Tasks + chat. */
  workAllowed: boolean;
  /** Security posture allows outbound mail (Free). */
  allowMail: boolean;
  /** Security posture allows the app to use the network (phone push). */
  allowAppNetwork: boolean;
  /** At least one phone channel is configured in Settings. */
  pushConfigured: boolean;
  outboundUsedToday: number;
  followUpsUsedToday: number;
  /** This lookout's follow-ups today, against its own `followUpsPerDay`. */
  lookoutFollowUpsToday: number;
  lookoutFollowUpsPerDay: number;
  /** The camera lets cloud models see its pictures. */
  cameraAllowsCloud: boolean;
  /**
   * For ask-gezel / run-craftbook: the provider the acting gezel runs on, or
   * null when no gezel could be resolved. `local` is an on-device engine.
   */
  actingProvider: { local: boolean; label: string; gezelName?: string } | null;
}

export type LookoutGateVerdict = { ok: true } | { ok: false; reason: string };

export function lookoutActionGate(
  action: LookoutAction,
  ctx: LookoutGateContext,
): LookoutGateVerdict {
  switch (action.kind) {
    case 'notify':
    case 'sound':
    case 'speak':
      return { ok: true };
    case 'push':
      if (!ctx.allowAppNetwork)
        return { ok: false, reason: 'Security settings keep Gezel off the network.' };
      if (!ctx.pushConfigured)
        return { ok: false, reason: 'No phone channel is set up in Settings.' };
      if (ctx.outboundUsedToday >= LOOKOUT_DAILY_CEILINGS.outbound) {
        return { ok: false, reason: "Reached today's limit for outside messages." };
      }
      return { ok: true };
    case 'email':
      if (!ctx.allowMail) {
        return { ok: false, reason: 'Email needs the Free security level (Settings → Security).' };
      }
      if (ctx.outboundUsedToday >= LOOKOUT_DAILY_CEILINGS.outbound) {
        return { ok: false, reason: "Reached today's limit for outside messages." };
      }
      return { ok: true };
    case 'ask-gezel':
    case 'run-craftbook': {
      if (!ctx.workAllowed) {
        return { ok: false, reason: 'Gezel is set to chat only, so tasks wait.' };
      }
      if (ctx.lookoutFollowUpsToday >= ctx.lookoutFollowUpsPerDay) {
        return { ok: false, reason: "Reached this lookout's follow-ups for today." };
      }
      if (ctx.followUpsUsedToday >= LOOKOUT_DAILY_CEILINGS.followUps) {
        return { ok: false, reason: "Reached today's limit for AI follow-ups." };
      }
      if (!ctx.actingProvider)
        return { ok: false, reason: 'No gezel is available to take this on.' };
      if (!ctx.actingProvider.local && !ctx.cameraAllowsCloud) {
        const who = ctx.actingProvider.gezelName ?? 'This gezel';
        return {
          ok: false,
          reason: `${who} uses ${ctx.actingProvider.label}; the camera's pictures would leave this computer.`,
        };
      }
      return { ok: true };
    }
  }
}
