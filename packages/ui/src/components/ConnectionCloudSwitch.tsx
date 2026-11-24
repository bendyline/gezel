import { SettingCheck } from './SettingsSection.js';

/** Where the connect form sends someone who wants the whole answer. */
export const CONNECTION_PRIVACY_URL = 'https://gezel.com/privacy/#google-microsoft';

/**
 * Whether cloud models may read what a connection brings in, for the types
 * that ask first (`connectorAsksBeforeCloud`: a Google account's data). Off
 * until the person turns it on, and it says what turning it on sends, because
 * this tick is their consent.
 */
export function ConnectionCloudSwitch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (allow: boolean) => void;
}) {
  return (
    <SettingCheck
      label="Let cloud AI read this"
      hint={
        checked
          ? 'A cloud AI you use, such as OpenAI or GitHub Copilot, can read this connection. What it reads goes to that provider.'
          : 'Only models that run on this computer can read this connection, and conversations that read it stay on this computer. Turn it on to let a cloud AI you use read it too.'
      }
      checked={checked}
      {...(disabled ? { disabled } : {})}
      onChange={onChange}
    />
  );
}
