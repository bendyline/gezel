import type { KnowledgeInstallEvent, TrustedKnowledgeCoordinate } from '@bendyline/gezel';
export type SharedEnsureResult =
  | { status: 'ready' }
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; error: string; mismatch: { expected: string; actual: string } };

export interface SharedKnowledgeInstaller {
  available(): boolean;
  ensure(
    coordinate: TrustedKnowledgeCoordinate,
    onEvent: (event: KnowledgeInstallEvent) => void,
    signal?: AbortSignal,
  ): Promise<SharedEnsureResult>;
  cancel(coordinate: TrustedKnowledgeCoordinate): Promise<boolean>;
}
