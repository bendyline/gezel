import type { ChatTurnErrorDetail } from '@bendyline/gezel';
import { api } from '../api.js';
import { isUserCancelledTurnError } from '../error-report.js';
import { requestSettingsSection } from '../settings-nav.js';
import { CapacityDeniedActions } from './CapacityDeniedActions.js';
import { ReportErrorLink } from './ReportErrorLink.js';
import {
  isExpectedAvailabilityError,
  isModelUnavailableError,
  isRetryableFailedTurn,
} from './chat-timeline-helpers.js';
import { modelSetupAction } from './model-setup-action.js';

/** A local metadata reset should settle promptly, even if an HTTP socket stalls. */
const FAILED_TURN_ACTION_TIMEOUT_MS = 10_000;

export interface FailedTurnActionState {
  busy?: 'acknowledge' | 'retry';
  error?: string;
}

export type SetFailedTurnAction = (sessionId: string, state: FailedTurnActionState | null) => void;

export async function acknowledgeFailedTurn(
  sessionId: string,
  projectId: string,
  setSessionAction: SetFailedTurnAction,
): Promise<void> {
  setSessionAction(sessionId, { busy: 'acknowledge' });
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), FAILED_TURN_ACTION_TIMEOUT_MS);
  try {
    await api.clearProjectErrors(projectId, controller.signal);
    window.dispatchEvent(new CustomEvent('gezel:session-error-cleared', { detail: { projectId } }));
  } catch {
    setSessionAction(sessionId, {
      error: controller.signal.aborted
        ? 'Clearing the alert took too long. Check the connection and try again.'
        : 'Could not clear the alert. Check the connection and try again.',
    });
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function retryFailedTurn(
  sessionId: string,
  setSessionAction: SetFailedTurnAction,
): Promise<void> {
  setSessionAction(sessionId, { busy: 'retry' });
  try {
    await api.retryChatSessionTurn(sessionId);
    // Keep the action disabled until the normal complete/error event settles
    // the attempt. A hidden retry seed will replace a preserved failed live
    // slot with the new thinking bubble as soon as the daemon starts it.
  } catch {
    setSessionAction(sessionId, {
      error: 'Retry could not start. Check the connection or settings, then try again.',
    });
  }
}

export function renderFailedTurnActions(args: {
  sessionId: string;
  errorMessage: string;
  errorDetail: ChatTurnErrorDetail | undefined;
  projectId: string | null;
  reportSurface: 'session-error' | 'chat-turn';
  action: FailedTurnActionState | undefined;
  setSessionAction: SetFailedTurnAction;
}): React.ReactNode {
  const {
    sessionId,
    errorMessage,
    errorDetail,
    projectId,
    reportSurface,
    action,
    setSessionAction,
  } = args;
  const busy = action?.busy;
  const retryable = isRetryableFailedTurn(errorMessage, errorDetail);
  const setup = modelSetupAction(errorMessage);
  return (
    <>
      <div className="timeline-session-error-actions" aria-label="Failed turn actions">
        {errorDetail?.code === 'capacity-denied' ? (
          <CapacityDeniedActions
            sessionId={sessionId}
            busy={busy !== undefined}
            onRetry={() => void retryFailedTurn(sessionId, setSessionAction)}
            onError={(message) => setSessionAction(sessionId, { error: message })}
          />
        ) : (
          retryable && (
            <button
              type="button"
              className="timeline-session-error-action timeline-session-error-action-primary"
              disabled={busy !== undefined}
              onClick={() => void retryFailedTurn(sessionId, setSessionAction)}
            >
              {busy === 'retry' ? 'Retrying…' : 'Retry'}
            </button>
          )
        )}
        {setup && (
          <button
            type="button"
            className="timeline-session-error-action secondary"
            disabled={busy !== undefined}
            onClick={() => {
              const { target } = setup;
              if (target.kind === 'home') {
                window.dispatchEvent(
                  new CustomEvent('gezel:navigate', { detail: { view: 'home' } }),
                );
                return;
              }
              requestSettingsSection(target.section);
              window.dispatchEvent(
                new CustomEvent('gezel:navigate', {
                  detail: { view: 'settings', section: target.section },
                }),
              );
            }}
          >
            {setup.label}
          </button>
        )}
        {!setup && isModelUnavailableError(errorMessage) && (
          <button
            type="button"
            className="timeline-session-error-action secondary"
            disabled={busy !== undefined}
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent('gezel:navigate', {
                  detail: { view: 'settings', section: 'defaults' },
                }),
              )
            }
          >
            Open Settings
          </button>
        )}
        {projectId && (
          <button
            type="button"
            className="timeline-session-error-action secondary"
            title="Clear this project's failed-turn alerts without rerunning the work"
            disabled={busy !== undefined}
            onClick={() => void acknowledgeFailedTurn(sessionId, projectId, setSessionAction)}
          >
            {busy === 'acknowledge' ? 'Acknowledging…' : 'Acknowledge'}
          </button>
        )}
        {!setup &&
          !isUserCancelledTurnError(errorMessage) &&
          !isExpectedAvailabilityError(errorDetail) && (
            <ReportErrorLink
              className="timeline-session-error-link"
              report={{ surface: reportSurface, message: errorMessage, detail: errorDetail }}
            />
          )}
      </div>
      {action?.error && (
        <p className="timeline-session-error-action-error" role="alert">
          {action.error}
        </p>
      )}
    </>
  );
}
