import type { LocalHarnessModelOption } from '@bendyline/gezel';
import type { ReactNode } from 'react';
import { useId } from 'react';
import { Select } from '../../primitives/index.js';
import {
  type HarnessSetupStatusLike,
  harnessStateLabel,
  isGezelOption,
} from './useHarnessSetupCard.js';

/**
 * The chrome every harness setup card shares: heading, state chip, the caution
 * paragraphs that explain why setup is unavailable, the reasons list, the
 * launch-command row, and the grouped model picker.
 *
 * Everything that carries the harness's own voice — intro prose, extra rows,
 * action buttons, confirmations — is passed in. The shell deliberately owns no
 * copy that names a harness.
 */
export function HarnessSetupShell({
  headingId,
  title,
  status,
  intro,
  notInstalledNote,
  repairExplainer,
  notice,
  reasonsIntro,
  configuredNote,
  commandRow,
  modelRow,
  extraRows,
  actions,
  error,
  emptyModelsNote,
  remoteMode,
  localDesktopMode,
  endpointsEnabled,
  repairable,
  children,
}: {
  headingId: string;
  title: string;
  status: HarnessSetupStatusLike | null;
  intro: ReactNode;
  notInstalledNote?: ReactNode;
  repairExplainer?: ReactNode;
  notice?: string | null;
  reasonsIntro: string;
  configuredNote?: ReactNode;
  commandRow?: ReactNode;
  modelRow?: {
    label: string;
    value: string;
    onChange: (value: string) => void;
    disabled: boolean;
  };
  extraRows?: ReactNode;
  actions: ReactNode;
  error?: string | null;
  emptyModelsNote: ReactNode;
  remoteMode: boolean;
  localDesktopMode: boolean;
  endpointsEnabled: boolean;
  repairable: boolean;
  children?: ReactNode;
}) {
  const modelLabelId = useId();
  const stateLabel = status ? harnessStateLabel(status.state) : 'Checking…';
  const gezelOptions = status?.models.filter(isGezelOption) ?? [];
  const rawModelOptions = status?.models.filter((candidate) => !isGezelOption(candidate)) ?? [];

  return (
    <section
      className="settings-subsection provider-card harness-setup-card"
      aria-labelledby={headingId}
    >
      <div className="settings-card-header">
        <h3 id={headingId}>{title}</h3>
        <span
          className={`harness-setup-state harness-setup-state--${status?.state ?? 'checking'}`}
          aria-live="polite"
        >
          {stateLabel}
        </span>
      </div>

      <p className="muted small harness-setup-intro">{intro}</p>

      {!status && !error && <p className="muted small">Checking the setup…</p>}

      {status && (
        <>
          {status.message && (
            <p
              className={
                status.state === 'conflict' || status.state === 'unavailable'
                  ? 'harness-setup-caution small'
                  : 'muted small'
              }
            >
              {status.message}
            </p>
          )}

          {repairable && repairExplainer && <p className="muted small">{repairExplainer}</p>}

          {notice && <p className="muted small">{notice}</p>}

          {notInstalledNote && status.state !== 'unavailable' && (
            <p className="muted small">{notInstalledNote}</p>
          )}

          {remoteMode && (
            <p className="harness-setup-caution small">
              One-click setup is unavailable while this app is connected to a remote Gezel service.
              Set it up on the computer where you plan to run it.
            </p>
          )}

          {!remoteMode && !localDesktopMode && (
            <p className="harness-setup-caution small">
              One-click setup is available in the Gezel desktop app when it is connected to your
              user service on this computer.
            </p>
          )}

          {!endpointsEnabled && (
            <p className="harness-setup-caution small">
              Turn on <strong>Allow apps to connect</strong> above before setting up or updating
              this.
            </p>
          )}

          {status.state === 'update-needed' && status.reasons.length > 0 && (
            <div className="harness-setup-reasons">
              <span className="small">{reasonsIntro}</span>
              <ul className="muted small">
                {status.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          )}

          {configuredNote && <p className="muted small">{configuredNote}</p>}

          {commandRow}

          {modelRow && status.models.length > 0 && (status.state !== 'conflict' || repairable) && (
            <div className="harness-setup-model-row">
              <span id={modelLabelId}>{modelRow.label}</span>
              <Select.Root
                value={modelRow.value}
                onValueChange={modelRow.onChange}
                disabled={modelRow.disabled}
              >
                <Select.Trigger aria-labelledby={modelLabelId}>
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  {gezelOptions.length > 0 && (
                    <Select.Group>
                      <Select.Label>Gezels</Select.Label>
                      {gezelOptions.map((candidate) => (
                        <Select.Item key={candidate.id} value={candidate.id}>
                          {optionLabel(candidate)}
                        </Select.Item>
                      ))}
                    </Select.Group>
                  )}
                  {gezelOptions.length > 0 && rawModelOptions.length > 0 && <Select.Separator />}
                  {rawModelOptions.length > 0 && (
                    <Select.Group>
                      <Select.Label>Raw models</Select.Label>
                      {rawModelOptions.map((candidate) => (
                        <Select.Item key={candidate.id} value={candidate.id}>
                          {optionLabel(candidate)}
                        </Select.Item>
                      ))}
                    </Select.Group>
                  )}
                </Select.Content>
              </Select.Root>
            </div>
          )}

          {status.models.length === 0 && status.state !== 'conflict' && (
            <p className="harness-setup-caution small">{emptyModelsNote}</p>
          )}

          {extraRows}

          <div className="harness-setup-actions">{actions}</div>
        </>
      )}

      {error && (
        <p className="error small harness-setup-error" role="alert">
          {error}
        </p>
      )}

      {children}
    </section>
  );
}

function optionLabel(candidate: LocalHarnessModelOption): string {
  return candidate.description ? `${candidate.label} — ${candidate.description}` : candidate.label;
}
