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

/**
 * Run the loopback OAuth flow for a cloud mail provider and link the account.
 * The desktop shell opens a 127.0.0.1 listener (`mailOAuthListen`), we build the
 * consent URL through the service, the shell opens the browser and captures the
 * `code` (`mailOAuthAwait`), and we complete the exchange. Throws when the shell
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
  const { authUrl, state } = await api.startMailOAuth(projectId, {
    provider,
    address,
    redirectUri,
  });
  const result = await shell.mailOAuthAwait(requestId, authUrl);
  if ('error' in result) throw new Error(result.error);
  await api.completeMailOAuth(projectId, { state: result.state || state, code: result.code });
}
