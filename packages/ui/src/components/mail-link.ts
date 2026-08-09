import { api } from '../api.js';

/** Mail providers offered in the link UIs (New Project dialog + Mail tab). */
export const MAIL_PROVIDERS: {
  id: 'imap' | 'gmail' | 'microsoft365' | 'outlook';
  label: string;
}[] = [
  { id: 'imap', label: 'IMAP' },
  { id: 'gmail', label: 'Gmail' },
  { id: 'microsoft365', label: 'Microsoft 365' },
  { id: 'outlook', label: 'Outlook.com' },
];

export type MailProviderId = (typeof MAIL_PROVIDERS)[number]['id'];

export const looksLikeEmail = (s: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

/** Microsoft directory tenant baked into each provider's token endpoints. */
const MS_TENANT: Partial<Record<MailProviderId, string>> = {
  microsoft365: 'organizations',
  outlook: 'consumers',
};

export interface ImapLinkInput {
  address: string;
  host: string;
  port?: number;
  secure?: boolean;
  pass: string;
  syncFolders?: string[];
}

/**
 * Link an IMAP mailbox as a `mail-imap` connector binding: the connection
 * blob goes to the SecretStore via the bind route; the account identity
 * (provider/address/folders) lives in the binding config.
 */
export async function linkImapMailbox(projectId: string, input: ImapLinkInput): Promise<void> {
  await api.bindConnector(projectId, {
    type: 'mail-imap',
    displayName: input.address,
    config: {
      provider: 'imap',
      address: input.address,
      syncFolders: input.syncFolders ?? ['INBOX'],
    },
    credential: {
      host: input.host,
      ...(input.port ? { port: input.port } : {}),
      ...(input.secure !== undefined ? { secure: input.secure } : {}),
      user: input.address,
      pass: input.pass,
    },
  });
}

/**
 * Run the loopback OAuth flow for a cloud mail provider and bind the account
 * as a `mail-<provider>` connector. The desktop shell opens a 127.0.0.1
 * listener (`mailOAuthListen`), we build the consent URL through the generic
 * connector OAuth route, the shell opens the browser and captures the `code`
 * (`mailOAuthAwait`), and we complete the exchange. Throws when the shell
 * isn't present (browser dev) or the user cancels.
 */
export async function connectMailboxOAuth(
  projectId: string,
  provider: Exclude<MailProviderId, 'imap'>,
  address: string,
): Promise<void> {
  const shell = window.__GEZEL__;
  if (!shell?.mailOAuthListen || !shell.mailOAuthAwait) {
    throw new Error('Connecting Gmail / Microsoft needs the Gezel desktop app.');
  }
  const { requestId, redirectUri } = await shell.mailOAuthListen();
  const tenant = MS_TENANT[provider];
  const { authUrl, state } = await api.startConnectorOAuth(projectId, {
    type: `mail-${provider}`,
    redirectUri,
    displayName: address,
    loginHint: address,
    config: {
      provider,
      address,
      ...(tenant ? { tenant } : {}),
    },
  });
  const result = await shell.mailOAuthAwait(requestId, authUrl);
  if ('error' in result) throw new Error(result.error);
  await api.completeConnectorOAuth(projectId, { state: result.state || state, code: result.code });
}
