import {
  type HealthResponse,
  type SecurityCapabilities,
  type SecurityLevel,
  type SecurityPresetLevel,
  classifySecurityLevel,
  resolveSecurityPolicy,
  securityCapabilitiesOf,
  securityPolicyForLevel,
} from '@bendyline/gezel';
import type { ConfigResponse } from '@bendyline/gezel-client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { SettingCheck, SettingsSection } from '../components/SettingsSection.js';
import { onRadioKeyDown } from '../primitives/radio-keyboard.js';
// Shared with the first-run picker so the posture copy never drifts.
import { SECURITY_LEVEL_PRESETS as LEVELS } from '../security-levels.js';

const SAVED_STATUS = 'Saved. Open chats restart on their next message.';

/** The capability toggles, in display order. */
const TOGGLES: ReadonlyArray<{
  key: keyof SecurityCapabilities;
  label: string;
  help: string;
}> = [
  {
    key: 'allowFileEdits',
    label: 'Edit files',
    help: "Gate the file-adjacent model powers: git tools and shared-document writes from scripts. Gezel-managed workspace writes are decided per project — internal workspaces start writable, while folders you opened require explicit consent. Provider-native CLI access follows that provider's project posture.",
  },
  {
    key: 'allowExternalChat',
    label: 'External chat providers',
    help: 'Expose cloud models (Claude, Copilot, ChatGPT). Off = local models only. You can still download new local models from Hugging Face.',
  },
  {
    key: 'allowExternalServices',
    label: 'External services',
    help: 'Let Gezel reach the open web and let project previews load external resources. Off blocks those paths; cloud chat has its own switch, and manual GitHub pulls and model downloads are unaffected.',
  },
  {
    key: 'allowScriptExecution',
    label: 'Execute scripts',
    help: 'Let Gezel run scripts it writes and run the script steps in plans. These run in a sandbox. Off still lets the app itself run npm / Node CLIs / MCP servers.',
  },
  {
    key: 'allowPackageScriptExecution',
    label: 'Run package scripts',
    help: "Let Gezel run a project's npm scripts and installed command-line tools, such as npm run test. These run outside the sandbox, as your account, with network access. It still asks you before each new or changed command. Coding craftbooks that check their work by running tests need this.",
  },
  {
    key: 'allowPackageScriptEdits',
    label: 'Edit package scripts',
    help: "Let Gezel add or change the scripts in a project's package.json. A script runs later, from Gezel or your own terminal, with your whole account. The rest of the file can still be edited.",
  },
  {
    key: 'allowAppNetwork',
    label: 'App network',
    help: 'Allow desktop-owned network traffic, including update checks and external resources in project previews. Off blocks background traffic and automatic renderer egress; downloads you start yourself, such as a model or a knowledge catalog, still work.',
  },
];

/**
 * Settings → Security & compliance: the security level as a described tray,
 * then each capability it sets. The `engagement-mode-<level>` class lets the
 * spectrum's ends recolor their latch (sealed green, open amber).
 */
export function SecurityComplianceSettings({
  config,
  onConfigChanged,
}: {
  config: ConfigResponse | null;
  onConfigChanged: (config: ConfigResponse) => void;
}) {
  const [status, setStatus] = useState('');

  // Display label follows the stored level when present; an absent policy
  // resolves fail-safe to Lockdown until first-run migration persists one.
  const level: SecurityLevel = resolveSecurityPolicy({
    securityPolicy: config?.securityPolicy,
  }).level;
  // Memoize so the toggle callback's dependency on `caps` is stable
  // across renders (otherwise it changes every render).
  const caps = useMemo<SecurityCapabilities>(
    () => securityCapabilitiesOf(resolveSecurityPolicy({ securityPolicy: config?.securityPolicy })),
    [config?.securityPolicy],
  );

  const persist = useCallback(
    async (next: ConfigResponse['securityPolicy']) => {
      setStatus('Saving…');
      try {
        const res = await api.updateConfig({ securityPolicy: next });
        onConfigChanged(res);
        window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
        setStatus(SAVED_STATUS);
      } catch (err) {
        setStatus(`Could not save: ${(err as Error).message}`);
      }
    },
    [onConfigChanged],
  );

  const selectLevel = useCallback(
    (next: SecurityPresetLevel) => void persist(securityPolicyForLevel(next)),
    [persist],
  );

  const toggle = useCallback(
    (key: keyof SecurityCapabilities, value: boolean) => {
      const nextCaps: SecurityCapabilities = { ...caps, [key]: value };
      // Re-label the slider: snaps back to a preset when the mix happens
      // to match one, otherwise becomes Custom.
      void persist({ level: classifySecurityLevel(nextCaps), ...nextCaps });
    },
    [caps, persist],
  );

  const preset = LEVELS.find((l) => l.id === level);

  return (
    <>
      <SettingsSection
        id="settings-security-level"
        className={`engagement-mode-${level}`}
        title="Security level"
        hint="One control over what Gezel may do: edit files, use cloud providers, reach the open web, and run scripts. Lock it down to try Gezel safely, and loosen it as you build trust."
      >
        <div>
          <div
            className="gz-tray gz-tray--described"
            role="radiogroup"
            onKeyDown={onRadioKeyDown}
            aria-label="Security posture"
          >
            {LEVELS.map((l) => (
              <button
                key={l.id}
                type="button"
                // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
                role="radio"
                aria-checked={level === l.id}
                tabIndex={level === l.id || (level === 'custom' && l === LEVELS[0]) ? 0 : -1}
                className={`gz-key${level === l.id ? ' gz-key-active' : ''}`}
                onClick={() => selectLevel(l.id)}
              >
                {l.label}
              </button>
            ))}
            {level === 'custom' && (
              <button
                type="button"
                // biome-ignore lint/a11y/useSemanticElements: the latched member of the radiogroup, reporting a derived state; inert by design.
                role="radio"
                aria-checked
                className="gz-key gz-key-active gz-key-state"
                disabled
              >
                Custom
              </button>
            )}
          </div>
          <p className="gz-tray-description" aria-live="polite">
            {level === 'custom' ? (
              <>
                <strong>Custom</strong> — individual capabilities below differ from the presets.
              </>
            ) : (
              <>
                <strong>{preset?.label}</strong> — {preset?.description ?? ''}
              </>
            )}
          </p>
        </div>
        <p className="gz-setting-hint">
          Locked-down work still flows into the artifacts sandbox, so reviews, prototypes, and
          documents keep working. Changing the level restarts open chats so the new rules apply from
          the next message; an answer already under way finishes first.
        </p>
      </SettingsSection>

      <SettingsSection
        id="settings-security-capabilities"
        title="Individual capabilities"
        hint="Changing a switch away from its level's setting makes the level Custom."
      >
        {TOGGLES.map((t) => (
          <SettingCheck
            key={t.key}
            label={t.label}
            hint={t.help}
            checked={caps[t.key]}
            onChange={(checked) => toggle(t.key, checked)}
          />
        ))}
        <WindowsSandboxSetting
          config={config}
          onConfigChanged={onConfigChanged}
          onStatus={setStatus}
        />
        {status && <output className="gz-setting-hint">{status}</output>}
      </SettingsSection>
    </>
  );
}

type ScriptSandboxHealth = NonNullable<HealthResponse['scriptSandbox']>;

function describeScriptSandbox(sandbox: ScriptSandboxHealth): string {
  switch (sandbox.state) {
    case 'active':
      return 'Active on this PC.';
    case 'probing':
      return 'Checking whether this PC can run it…';
    case 'disabled':
      return sandbox.reason === 'turned off in Settings'
        ? 'Off.'
        : `Off: ${sandbox.reason ?? 'turned off'}.`;
    case 'unavailable':
      return `Not available on this PC: ${sandbox.reason ?? 'the check did not pass'}.`;
  }
}

/**
 * The Windows script container. Shown only where the daemon reports one,
 * which is a Windows daemon that runs scripts; everywhere else the platform's
 * own sandbox applies and there is nothing to choose.
 */
function WindowsSandboxSetting({
  config,
  onConfigChanged,
  onStatus,
}: {
  config: ConfigResponse | null;
  onConfigChanged: (config: ConfigResponse) => void;
  onStatus: (status: string) => void;
}) {
  const [sandbox, setSandbox] = useState<ScriptSandboxHealth | null>(null);
  const refresh = useCallback(async () => {
    try {
      setSandbox((await api.health()).scriptSandbox ?? null);
    } catch {
      // Health is advisory here; without it the setting stays hidden.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (sandbox?.state !== 'probing') return;
    const timer = setTimeout(() => void refresh(), 1_500);
    return () => clearTimeout(timer);
  }, [sandbox, refresh]);

  if (!sandbox) return null;
  const enabled = config?.scriptSandbox?.windowsContainer !== false;

  const save = async (next: boolean) => {
    onStatus('Saving…');
    try {
      const res = await api.updateConfig({ scriptSandbox: { windowsContainer: next } });
      onConfigChanged(res);
      window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
      onStatus(SAVED_STATUS);
      await refresh();
    } catch (err) {
      onStatus(`Could not save: ${(err as Error).message}`);
    }
  };

  return (
    <SettingCheck
      label="Windows sandbox"
      hint={
        <>
          Run the scripts Gezel writes inside Windows&rsquo; process container, which limits them to
          their project folder and blocks the network for scripts that shouldn&rsquo;t use it. Off,
          those scripts don&rsquo;t run.{' '}
          <span aria-live="polite">{describeScriptSandbox(sandbox)}</span>
        </>
      }
      checked={enabled}
      onChange={(checked) => void save(checked)}
    />
  );
}
