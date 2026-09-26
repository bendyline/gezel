import type {
  ConfigureOfficeRequest,
  LibreOfficeHostReport,
  LibreOfficeSetupStatusResponse,
  OfficeHostReport,
  OfficeSetupStatusResponse,
} from '@bendyline/gezel';

/** The owning client's authenticated JSON request, error mapping included. */
export type ClientJsonRequest = <T>(method: string, path: string, body?: unknown) => Promise<T>;

/**
 * Setup state for the Word / Excel / PowerPoint add-ins and the LibreOffice
 * extension. Reached as `client.officeIntegrations`. The daemon owns the
 * certificate, listener, manifests, and `.oxt`; the desktop app performs the
 * steps in the user's OS profile and reports each outcome here. See
 * docs/office-integrations.md.
 */
export class OfficeIntegrationsClient {
  constructor(private readonly request: ClientJsonRequest) {}

  getOfficeSetupStatus(): Promise<OfficeSetupStatusResponse> {
    return this.request('GET', '/api/office-setup');
  }

  /** Mint or reuse the Office certificate, start the Office listener, and write manifests. */
  configureOffice(body: ConfigureOfficeRequest): Promise<OfficeSetupStatusResponse> {
    return this.request('PUT', '/api/office-setup', body);
  }

  /** The desktop app reports what it did in the user's OS profile. */
  reportOfficeHost(body: OfficeHostReport): Promise<OfficeSetupStatusResponse> {
    return this.request('POST', '/api/office-setup/host-report', body);
  }

  removeOfficeSetup(): Promise<OfficeSetupStatusResponse> {
    return this.request('DELETE', '/api/office-setup');
  }

  getLibreOfficeSetupStatus(): Promise<LibreOfficeSetupStatusResponse> {
    return this.request('GET', '/api/libreoffice-setup');
  }

  configureLibreOffice(): Promise<LibreOfficeSetupStatusResponse> {
    return this.request('PUT', '/api/libreoffice-setup');
  }

  reportLibreOfficeHost(body: LibreOfficeHostReport): Promise<LibreOfficeSetupStatusResponse> {
    return this.request('POST', '/api/libreoffice-setup/host-report', body);
  }

  removeLibreOfficeSetup(): Promise<LibreOfficeSetupStatusResponse> {
    return this.request('DELETE', '/api/libreoffice-setup');
  }
}
