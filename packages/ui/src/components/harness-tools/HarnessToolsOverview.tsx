import type {
  HarnessImageMode,
  HarnessIssueMode,
  HarnessMemoryMode,
  HarnessNewFolderMode,
  HarnessToolsConfigUpdate,
} from '@bendyline/gezel';
import { useId } from 'react';
import { onRadioKeyDown } from '../../primitives/radio-keyboard.js';
import { formatAbsoluteTime, formatRelativeTime } from '../../relative-time.js';
import type { HarnessTools } from './useHarnessTools.js';

interface Choice<T extends string> {
  value: T;
  label: string;
}

const MEMORY: ReadonlyArray<Choice<HarnessMemoryMode>> = [
  { value: 'off', label: 'Off' },
  { value: 'read', label: 'Read' },
  { value: 'save', label: 'Save to the project' },
];

const IMAGES: ReadonlyArray<Choice<HarnessImageMode>> = [
  { value: 'off', label: 'Off' },
  { value: 'local', label: 'On this computer' },
  { value: 'any', label: 'Any image engine' },
];

const ISSUES: ReadonlyArray<Choice<HarnessIssueMode>> = [
  { value: 'off', label: 'Off' },
  { value: 'read', label: 'List them' },
  { value: 'triage', label: 'List and judge them' },
];

const NEW_FOLDERS: ReadonlyArray<Choice<HarnessNewFolderMode>> = [
  { value: 'add', label: 'Add to Gezel' },
  { value: 'existing', label: 'Only folders already in Gezel' },
];

function Tray<T extends string>({
  label,
  hint,
  choices,
  value,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  choices: ReadonlyArray<Choice<T>>;
  value: T;
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  const labelId = useId();
  return (
    <div className="harness-tools-choice">
      <span id={labelId} className="small">
        {label}
      </span>
      <div
        className="gz-tray"
        role="radiogroup"
        aria-labelledby={labelId}
        onKeyDown={onRadioKeyDown}
      >
        {choices.map((choice) => (
          <button
            key={choice.value}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native radio cannot carry the keys-in-trays treatment.
            role="radio"
            aria-checked={value === choice.value}
            tabIndex={value === choice.value ? 0 : -1}
            disabled={disabled}
            className={`gz-key${value === choice.value ? ' gz-key-active' : ''}`}
            onClick={() => {
              if (value !== choice.value) onChange(choice.value);
            }}
          >
            {choice.label}
          </button>
        ))}
      </div>
      <p className="muted small">{hint}</p>
    </div>
  );
}

/**
 * The Overview tab's section for Gezel's tools in other AI apps: the master
 * switch, what every app may do, which apps are using the tools now, and the
 * folders an app was stopped in.
 */
export function HarnessToolsOverview({ tools }: { tools: HarnessTools }) {
  const { status } = tools;
  const config = status?.config;
  const save = (update: HarnessToolsConfigUpdate) => void tools.updateConfig(update);
  const saving = tools.busy === 'config';

  return (
    <div className="settings-subsection harness-tools-overview">
      <h3>Gezel's tools in other apps</h3>
      <p className="muted small">
        Claude Code, Claude Desktop, Codex, Cursor and VS Code can search your projects, documents
        and knowledge, read and make Office files, describe and make images, remember things, and
        check the issues Gezel found overnight. Each one works with the project for the folder it
        was started in. Set one up on its own tab.
      </p>

      {status?.unavailableReason && (
        <p className="harness-setup-caution small">{status.unavailableReason}</p>
      )}

      {config && (
        <>
          <label className="debug-toggle">
            <input
              type="checkbox"
              checked={config.enabled}
              disabled={saving}
              onChange={(e) => save({ enabled: e.target.checked })}
            />
            <span>Let other apps use Gezel's tools</span>
          </label>

          <Tray
            label="Memory"
            hint="Saved memories go to the project the app is working in, labeled with the app, and every gezel there can see them."
            choices={MEMORY}
            value={config.memory}
            disabled={!config.enabled || saving}
            onChange={(memory) => save({ memory })}
          />
          <Tray
            label="Images"
            hint={
              config.images === 'any'
                ? 'Apps can use any image engine you set up, including cloud engines, which may charge for each image without asking first.'
                : 'Images an app makes are saved in Gezel; the app copies one into its folder if it needs it there.'
            }
            choices={IMAGES}
            value={config.images}
            disabled={!config.enabled || saving}
            onChange={(images) => save({ images })}
          />
          <Tray
            label="Issues"
            hint={
              config.issues === 'triage'
                ? 'Apps can work through the suspected problems the night shift found and tell Gezel which are real. Each verdict shows which app gave it, and you can reopen any issue.'
                : config.issues === 'read'
                  ? "Apps can see the night shift's issues but not close or confirm them."
                  : 'Apps never see the issues the night shift found.'
            }
            choices={ISSUES}
            value={config.issues}
            disabled={!config.enabled || saving}
            onChange={(issues) => save({ issues })}
          />
          <Tray
            label="New folders"
            hint={
              config.newFolders === 'add'
                ? 'A folder an app opens that is not in Gezel yet becomes a read-only project, so Gezel can index and search it.'
                : 'In a folder Gezel does not know, an app gets your library, memories and knowledge, but no folder search.'
            }
            choices={NEW_FOLDERS}
            value={config.newFolders}
            disabled={!config.enabled || saving}
            onChange={(newFolders) => save({ newFolders })}
          />
        </>
      )}

      {status && status.connections.length > 0 && (
        <div className="connected-apps-table-wrap">
          <table className="connected-apps-table" aria-label="Apps using Gezel's tools">
            <thead>
              <tr>
                <th scope="col">App</th>
                <th scope="col">Working in</th>
                <th scope="col">Last used</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {status.connections.map((c) => (
                <tr key={c.appId}>
                  <td data-label="App">
                    <span className="connected-apps-name">{c.label}</span>
                  </td>
                  <td data-label="Working in">
                    <div>{c.projectName ?? 'No project'}</div>
                    {c.folder && <code className="small">{c.folder}</code>}
                  </td>
                  <td
                    data-label="Last used"
                    title={c.lastUsedAt ? formatAbsoluteTime(c.lastUsedAt) : undefined}
                  >
                    {c.lastUsedAt ? formatRelativeTime(c.lastUsedAt) : 'Not yet'}
                  </td>
                  <td>
                    <button
                      type="button"
                      disabled={tools.busy !== null}
                      aria-label={`Stop ${c.label} in ${c.projectName ?? 'this folder'}`}
                      onClick={() => void tools.stop(c.appId)}
                    >
                      Stop for this folder
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {status && status.blocked.length > 0 && (
        <div className="harness-tools-blocked">
          <span className="small">Stopped</span>
          <ul className="muted small">
            {status.blocked.map((b) => (
              <li key={`${b.client}:${b.projectId}`}>
                {b.label} in{' '}
                {b.projectName ?? (b.projectId === 'none' ? 'no project' : b.projectId)}{' '}
                <button
                  type="button"
                  className="link-button"
                  disabled={tools.busy !== null}
                  onClick={() => void tools.unblock({ client: b.client, projectId: b.projectId })}
                >
                  Turn back on
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {tools.error && (
        <p className="error small" role="alert">
          {tools.error}
        </p>
      )}
    </div>
  );
}
