import type { HookPhase, HookResult, HookSpec } from '@bendyline/gezel';
export interface ActiveHook {
  spec: HookSpec;
  craftbookId: string;
  /** Compiled regex from `spec.matcher`. */
  matcher: RegExp;
}

export type HookRunner = (
  hook: ActiveHook,
  ctx: {
    phase: HookPhase;
    toolName: string;
    args: Record<string, unknown>;
    result?: { text: string; isError: boolean };
  },
) => Promise<HookResult>;

export interface ToolGroundingHooks {
  checkWrite(
    toolName: string,
    args: Record<string, unknown>,
  ): { kind: 'reject'; error: string } | { kind: 'allow'; args: Record<string, unknown> } | null;
  /** `source.thirdParty` is true for a tool served by any server but gezel's own. */
  labelEvidence(
    toolName: string,
    args: Record<string, unknown>,
    text: string,
    source?: { thirdParty: boolean },
  ): string | null;
}
