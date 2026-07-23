import type { SecurityPresetLevel } from '@bendyline/gezel';

/**
 * Canonical security-posture presets: the pill label + the scenario copy
 * shown under it. Single source of truth so the first-run onboarding
 * (HomeView) and the Settings → Security & Compliance tab
 * (SecurityComplianceSettings) render identical descriptions and never drift.
 */
export interface SecurityLevelPreset {
  id: SecurityPresetLevel;
  label: string;
  description: string;
  /** The ★-marked "good default" — highlighted in the first-run picker. */
  recommended?: boolean;
}

export const SECURITY_LEVEL_PRESETS: ReadonlyArray<SecurityLevelPreset> = [
  {
    id: 'super-lockdown',
    label: 'Super Lockdown',
    description:
      'Nothing leaves your machine. Local models only — no external services, no script execution, no background app network, no model git. You can still do a lot in Super Lockdown mode, though: review, scan, index, chat, and build reports, prototypes, PowerPoints, images as well as do code reviews, and more. Gezels can edit files in internal project workspaces; folders you open stay read-only unless you opt them in per project. Safest to get started, and you can move to more permissive modes later.',
  },
  {
    id: 'lockdown',
    label: 'Lockdown',
    description:
      'A posture for trusted work. Edit files directly, run scripts, use cloud chat providers, and do GitHub read/write — but besides cloud chat providers (which can do a lot), we still try to keep everything local. Auto-update is allowed.',
    recommended: true,
  },
  {
    id: 'free',
    label: 'Unrestricted',
    description:
      'Everything: internet research, the full toolset gallery, cloud providers, scripts, and file edits. The most capable posture — choose it when you trust the work and the gezels.',
  },
];
