import type {
  LocalHarnessBridge,
  LocalHarnessModelOption,
  LocalHarnessSetupState,
} from '@bendyline/gezel';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The status spine every harness card reads. Each integration's response
 * extends this with its own detection fields and artifact identity.
 */
export interface HarnessSetupStatusLike {
  state: LocalHarnessSetupState;
  models: LocalHarnessModelOption[];
  configuredModel?: string;
  recommendedModel?: string;
  reasons: string[];
  message?: string;
  endpointsEnabled: boolean;
  launchCommand: string;
  bridge: LocalHarnessBridge;
  canConfigure: boolean;
  canRemove: boolean;
  canRepair: boolean;
}

export interface UseHarnessSetupCardOptions<S extends HarnessSetupStatusLike, C extends string> {
  /** Harness name as it appears in error prose, e.g. `'OpenCode'`. */
  label: string;
  endpointsEnabled: boolean;
  fetchStatus: () => Promise<S>;
  /** Perform the confirmed action and return the fresh status. */
  runAction: (confirmation: C, model: string) => Promise<S>;
  /** Sentence prefix for a failed action, e.g. `'Could not remove the setup'`. */
  errorPrefix: (confirmation: C, state: LocalHarnessSetupState | undefined) => string;
  /** Surface a `.backup` path the last action moved aside. */
  backupNotice?: (status: S) => string | null;
  /** False for integrations that publish the whole roster with no default model. */
  modelSelection?: boolean;
  onChanged?: () => void | Promise<void>;
}

/**
 * State and behaviour shared by every harness setup card: status fetching, the
 * model-selection cascade, the confirm-then-act flow, clipboard handling, and
 * the desktop-mode gating that decides whether one-click setup is meaningful
 * at all. The prose, dialogs, and any harness-specific actions stay in the
 * card — this owns only what is identical between them.
 */
export function useHarnessSetupCard<S extends HarnessSetupStatusLike, C extends string>(
  opts: UseHarnessSetupCardOptions<S, C>,
) {
  const copyTimerRef = useRef<number | null>(null);
  const [status, setStatus] = useState<S | null>(null);
  const [model, setModel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<C | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // Cards pass fresh closures every render; holding the latest here keeps
  // `refresh` stable, so the mount effect fetches once instead of looping.
  const latest = useRef(opts);
  latest.current = opts;

  const applyStatus = useCallback((next: S) => {
    setStatus(next);
    const backup = latest.current.backupNotice?.(next);
    if (backup) setNotice(backup);
    setModel((current) => {
      const available = new Set(next.models.map((candidate) => candidate.id));
      if (current && available.has(current)) return current;
      if (next.configuredModel && available.has(next.configuredModel)) return next.configuredModel;
      if (next.recommendedModel && available.has(next.recommendedModel)) {
        return next.recommendedModel;
      }
      return next.models[0]?.id ?? '';
    });
  }, []);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      applyStatus(await latest.current.fetchStatus());
    } catch (err) {
      setError(
        `Could not check the ${latest.current.label} setup — ${harnessApiErrorMessage(err)}`,
      );
    }
  }, [applyStatus]);

  useEffect(() => {
    void refresh();
    return () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, [refresh]);

  const desktopMode = window.__GEZEL__?.mode;
  const localDesktopMode =
    desktopMode === 'local-adopt' ||
    desktopMode === 'local-spawn-packaged' ||
    desktopMode === 'local-spawn-dev' ||
    desktopMode === 'embedded';
  const remoteMode = desktopMode === 'remote';
  const configured = status?.state === 'configured' || status?.state === 'update-needed';
  const canLaunch =
    status?.state === 'configured' &&
    status.bridge.listening &&
    opts.endpointsEnabled &&
    localDesktopMode;
  const modelSelection = opts.modelSelection !== false;
  const modelChanged = modelSelection && configured && model !== status?.configuredModel;
  const repairable = status?.state === 'conflict' && status.canRepair;
  const needsConfigure =
    status?.state === 'not-configured' ||
    status?.state === 'update-needed' ||
    modelChanged ||
    repairable;
  // `canConfigure` already refuses both conflict and unavailable; repair is the
  // one path that deliberately proceeds from a conflict.
  const canPublish =
    status?.state === 'conflict' ? status.canRepair : (status?.canConfigure ?? false);
  const configureDisabled =
    busy ||
    !localDesktopMode ||
    !opts.endpointsEnabled ||
    !canPublish ||
    (modelSelection && !model);
  const selectionDisabled = busy || !localDesktopMode || !opts.endpointsEnabled || !canPublish;

  const runConfirmedAction = useCallback(async () => {
    if (!confirmation || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      applyStatus(await latest.current.runAction(confirmation, model));
      setConfirmation(null);
      void Promise.resolve(latest.current.onChanged?.()).catch(() => {
        // The setup mutation succeeded. Roster refresh is best-effort and its
        // own four-second poll will recover without turning success into error.
      });
    } catch (err) {
      setConfirmation(null);
      setError(
        `${latest.current.errorPrefix(confirmation, status?.state)} — ${harnessApiErrorMessage(err)}`,
      );
    } finally {
      setBusy(false);
    }
  }, [applyStatus, busy, confirmation, model, status?.state]);

  const copyLaunchCommand = useCallback(async () => {
    if (!status?.launchCommand) return;
    setError(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard access is unavailable');
      await navigator.clipboard.writeText(status.launchCommand);
      setCopied(true);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        copyTimerRef.current = null;
        setCopied(false);
      }, 2_000);
    } catch (err) {
      setError(
        `Could not copy the ${latest.current.label} command — ${harnessApiErrorMessage(err)}`,
      );
    }
  }, [status?.launchCommand]);

  return {
    status,
    model,
    setModel,
    error,
    setError,
    notice,
    confirmation,
    setConfirmation,
    busy,
    copied,
    refresh,
    runConfirmedAction,
    copyLaunchCommand,
    localDesktopMode,
    remoteMode,
    configured,
    canLaunch,
    modelChanged,
    repairable,
    needsConfigure,
    configureDisabled,
    selectionDisabled,
  };
}

export function harnessStateLabel(state: LocalHarnessSetupState): string {
  switch (state) {
    case 'not-configured':
      return 'Not configured';
    case 'configured':
      return 'Configured';
    case 'update-needed':
      return 'Update needed';
    case 'conflict':
      return 'Needs attention';
    case 'unavailable':
      return 'Unavailable';
  }
}

export function isGezelOption(option: LocalHarnessModelOption): boolean {
  return option.kind === 'gezel' || option.id.startsWith('gezel:');
}

export function harnessApiErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'details' in error) {
    const details = (error as { details?: unknown }).details;
    if (typeof details === 'string' && details) return details;
    if (details && typeof details === 'object') {
      const record = details as Record<string, unknown>;
      if (typeof record.message === 'string' && record.message) return record.message;
      if (typeof record.error === 'string' && record.error) return record.error;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
