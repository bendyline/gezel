import {
  type SecurityCapabilities,
  type SecurityLevel,
  type SecurityPresetLevel,
  classifySecurityLevel,
  resolveSecurityPolicy,
  securityPolicyForLevel,
} from '@bendyline/gezel';
import type { ConfigResponse } from '@bendyline/gezel-client';
import { useCallback, useMemo, useState } from 'react';
import { api } from '../api.js';
// Shared with the first-run picker so the posture copy never drifts.
import { SECURITY_LEVEL_PRESETS as LEVELS } from '../security-levels.js';

/** The five capability toggles, in display order. */
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
    help: 'Let gezellen reach the open web and let project previews load external resources. Off blocks those paths; cloud chat has its own switch, and manual GitHub pulls and model downloads are unaffected.',
  },
  {
    key: 'allowScriptExecution',
    label: 'Execute scripts',
    help: 'Let gezellen run scripts they write and run craftbook script steps. Off still lets the app itself run npm / Node CLIs / MCP servers.',
  },
  {
    key: 'allowAppNetwork',
    label: 'App network',
    help: 'Allow desktop-owned network traffic, including update checks and external resources in project previews. Off blocks background traffic and automatic renderer egress.',
  },
];

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
  const caps = useMemo<SecurityCapabilities>(() => {
    const resolved = resolveSecurityPolicy({ securityPolicy: config?.securityPolicy });
    return {
      allowFileEdits: resolved.allowFileEdits,
      allowExternalChat: resolved.allowExternalChat,
      allowExternalServices: resolved.allowExternalServices,
      allowScriptExecution: resolved.allowScriptExecution,
      allowAppNetwork: resolved.allowAppNetwork,
    };
  }, [config?.securityPolicy]);

  const persist = useCallback(
    async (next: ConfigResponse['securityPolicy']) => {
      setStatus('saving…');
      try {
        const res = await api.updateConfig({ securityPolicy: next });
        onConfigChanged(res);
        window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
        setStatus('saved — open chats restart on their next message.');
      } catch (err) {
        setStatus(`save failed: ${(err as Error).message}`);
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

  return (
    <section className={`engagement-mode-panel engagement-mode-${level}`}>
      <h3>Security &amp; Compliance</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        One control over what gezellen are allowed to do — edits, cloud providers, the open web, and
        script execution. Slide toward lockdown to make Gezel safe to try; loosen it as you build
        trust. Locked-down work still flows into the artifacts sandbox, so reviews, prototypes, and
        documents keep working.
      </p>
      <p className="muted small" style={{ marginTop: '-0.35rem' }}>
        Changing the posture restarts open chat sessions so gezellen pick up the new rules on their
        next message. A gezel that is answering right now finishes that answer first.
      </p>

      <div
        className="engagement-mode-switch gz-tray gz-tray--described"
        role="radiogroup"
        aria-label="Security posture"
      >
        {LEVELS.map((l) => (
          <button
            key={l.id}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
            role="radio"
            aria-checked={level === l.id}
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
      <p className="engagement-mode-description gz-tray-description" aria-live="polite">
        {level === 'custom' ? (
          <>
            <strong>Custom</strong> — individual capabilities below differ from the presets.
          </>
        ) : (
          <>
            <strong>{LEVELS.find((l) => l.id === level)?.label}</strong> —{' '}
            {LEVELS.find((l) => l.id === level)?.description ?? ''}
          </>
        )}
      </p>

      <div className="workshop-tempo" style={{ marginTop: '1rem' }}>
        <h4 className="workshop-tempo-heading">Advanced — individual capabilities</h4>
        <p className="muted small" style={{ margin: '0 0 0.5rem' }}>
          Changing any switch off-preset sets the level to “Custom”.
        </p>
        {TOGGLES.map((t) => (
          <label
            key={t.key}
            className="debug-toggle"
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: '0.5rem',
              marginTop: '0.6rem',
            }}
          >
            <input
              type="checkbox"
              checked={caps[t.key]}
              onChange={(e) => toggle(t.key, e.target.checked)}
            />
            <span>
              <strong>{t.label}</strong>
              <br />
              <span className="muted small">{t.help}</span>
            </span>
          </label>
        ))}
      </div>

      {status && (
        <p className="muted" style={{ marginTop: '0.75rem' }}>
          {status}
        </p>
      )}
    </section>
  );
}
