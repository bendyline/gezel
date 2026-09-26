import { z } from 'zod';
import { LocalHarnessSetupStateSchema } from './local-harness.js';

/**
 * Microsoft Word, Excel and PowerPoint (desktop) integration.
 *
 * The daemon owns everything under the gezel home: the per-user Office CA and
 * leaf, the stable HTTPS listener, the add-in manifests, and this status. The
 * desktop app performs the steps that touch the user's OS profile (trusting
 * the CA, registering each manifest with Office) and reports the outcome
 * back through `POST /api/office-setup/host-report`.
 */

export const OfficeAppSchema = z.enum(['word', 'excel', 'powerpoint']);
export type OfficeApp = z.infer<typeof OfficeAppSchema>;
export const OFFICE_APPS: readonly OfficeApp[] = OfficeAppSchema.options;

export const OFFICE_APP_LABELS: Record<OfficeApp, string> = {
  word: 'Word',
  excel: 'Excel',
  powerpoint: 'PowerPoint',
};

/** App id the task pane registers under; one grant covers all three hosts (they share an origin). */
export const OFFICE_PANE_APP_ID = 'office';

export const OfficeListenerStatusSchema = z.object({
  state: z.enum(['stopped', 'listening', 'port-in-use', 'error']),
  port: z.number().int().nonnegative(),
  /** `https://localhost:<port>`, the origin every manifest names. */
  origin: z.string(),
  message: z.string().optional(),
});
export type OfficeListenerStatus = z.infer<typeof OfficeListenerStatusSchema>;

export const OfficeAppSetupSchema = z.object({
  app: OfficeAppSchema,
  label: z.string(),
  /** Installed on this computer, as far as the daemon can tell. */
  detected: z.boolean(),
  /** Chosen by the user at setup. */
  selected: z.boolean(),
  /** Add-in GUID, stable per gezel home. */
  manifestId: z.string().optional(),
  manifestPath: z.string().optional(),
  /** Last report from the desktop app: `null` = not reported since the manifest changed. */
  registered: z.boolean().nullable(),
  error: z.string().optional(),
});
export type OfficeAppSetup = z.infer<typeof OfficeAppSetupSchema>;

export const OfficeTrustStatusSchema = z.object({
  /** Public certificate of the per-user CA the desktop app installs. */
  caPem: z.string().optional(),
  caSha256: z.string().optional(),
  /** Windows stores address certificates by SHA-1 thumbprint. */
  caSha1: z.string().optional(),
  caCommonName: z.string().optional(),
  /**
   * The listener's current leaf (public). The desktop app verifies it for
   * `localhost` against the OS trust store — the same evaluation the Office
   * webview makes — rather than trusting that an install call succeeded.
   */
  leafPem: z.string().optional(),
  /** Last report from the desktop app: `null` = not reported since the CA changed. */
  installed: z.boolean().nullable(),
  error: z.string().optional(),
  reportedAt: z.string().optional(),
});
export type OfficeTrustStatus = z.infer<typeof OfficeTrustStatusSchema>;

export const OfficeSetupStatusResponseSchema = z.object({
  state: LocalHarnessSetupStateSchema,
  reasons: z.array(z.string()),
  message: z.string().optional(),
  /** Office desktop add-ins exist on Windows and macOS only. */
  hostSupported: z.boolean(),
  officeInstalled: z.boolean(),
  apps: z.array(OfficeAppSetupSchema),
  listener: OfficeListenerStatusSchema,
  trust: OfficeTrustStatusSchema,
  leafNotAfter: z.string().optional(),
  canConfigure: z.boolean(),
  canRemove: z.boolean(),
});
export type OfficeSetupStatusResponse = z.infer<typeof OfficeSetupStatusResponseSchema>;

export const ConfigureOfficeRequestSchema = z.object({
  apps: z.array(OfficeAppSchema).min(1),
});
export type ConfigureOfficeRequest = z.infer<typeof ConfigureOfficeRequestSchema>;

export const OfficeHostReportSchema = z.object({
  trust: z.object({ installed: z.boolean(), error: z.string().max(2000).optional() }).optional(),
  apps: z
    .partialRecord(
      OfficeAppSchema,
      z.object({ registered: z.boolean(), error: z.string().max(2000).optional() }),
    )
    .optional(),
});
export type OfficeHostReport = z.infer<typeof OfficeHostReportSchema>;

// ── LibreOffice ────────────────────────────────────────────────────────────

/** Identifier in the extension's description.xml; `unopkg remove` takes this. */
export const LIBREOFFICE_EXTENSION_ID = 'com.bendyline.gezel';
/** App id the extension registers under. */
export const LIBREOFFICE_APP_ID = 'libreoffice';

export const LibreOfficeSetupStatusResponseSchema = z.object({
  state: LocalHarnessSetupStateSchema,
  reasons: z.array(z.string()),
  message: z.string().optional(),
  libreofficeInstalled: z.boolean(),
  sofficePath: z.string().optional(),
  unopkgPath: z.string().optional(),
  version: z.string().optional(),
  /** The `.oxt` this gezel build ships, when present. */
  oxtPath: z.string().optional(),
  oxtSha256: z.string().optional(),
  extensionId: z.string(),
  /** Last report from the desktop app: `null` = never reported. */
  installed: z.boolean().nullable(),
  error: z.string().optional(),
  reportedAt: z.string().optional(),
  canConfigure: z.boolean(),
  canRemove: z.boolean(),
});
export type LibreOfficeSetupStatusResponse = z.infer<typeof LibreOfficeSetupStatusResponseSchema>;

export const LibreOfficeHostReportSchema = z.object({
  installed: z.boolean(),
  error: z.string().max(2000).optional(),
});
export type LibreOfficeHostReport = z.infer<typeof LibreOfficeHostReportSchema>;
