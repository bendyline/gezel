/**
 * IMAP mail provider (imapflow). Connects with implicit TLS by default,
 * incrementally scans folders by UID (resetting on a UIDVALIDITY change), and
 * fetches raw RFC822 for the shared MIME parser. Runs in the trusted service
 * process (not the sandbox), like the other network providers.
 */

import { createLogger } from '@bendyline/gezel';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { parseRawMessage } from '../mime.js';
import type {
  FolderChanges,
  ImapCredential,
  MailCursor,
  MailEnvelope,
  MailFolder,
  MailMessage,
  MailProvider,
  OutgoingMail,
} from '../types.js';

const log = createLogger('mail');

interface EnvAddr {
  name?: string;
  address?: string;
}

function formatEnvAddr(list: EnvAddr[] | undefined): string {
  if (!list || list.length === 0) return '';
  return list
    .map((a) => (a.name ? `${a.name} <${a.address ?? ''}>` : (a.address ?? '')))
    .filter(Boolean)
    .join(', ');
}

const toIso = (d: Date | string | number | undefined): string =>
  d ? new Date(d).toISOString() : new Date(0).toISOString();

export class ImapMailProvider implements MailProvider {
  readonly kind = 'imap' as const;
  private client: ImapFlow | null = null;

  constructor(
    private readonly accountAddress: string,
    private readonly cred: ImapCredential,
  ) {}

  async ensureAuth(): Promise<void> {
    if (this.client?.usable) return;
    const secure = this.cred.secure ?? true;
    const client = new ImapFlow({
      host: this.cred.host,
      port: this.cred.port ?? (secure ? 993 : 143),
      secure,
      auth: { user: this.cred.user, pass: this.cred.pass },
      logger: false,
      // Don't let a wedged server hang a sync tick forever.
      socketTimeout: 60_000,
    });
    client.on('error', (err) => log.warn(`imap error (${this.accountAddress}): ${err}`));
    await client.connect();
    this.client = client;
  }

  private require(): ImapFlow {
    if (!this.client) throw new Error('imap provider not connected; call ensureAuth() first');
    return this.client;
  }

  async listFolders(): Promise<MailFolder[]> {
    const list = await this.require().list();
    return list.map((f) => ({ path: f.path, name: f.name }));
  }

  async listChangesSince(folder: string, cursor: MailCursor | undefined): Promise<FolderChanges> {
    const client = this.require();
    const lock = await client.getMailboxLock(folder);
    try {
      const mailbox = client.mailbox;
      if (!mailbox || typeof mailbox === 'boolean') {
        return { envelopes: [], cursor: cursor ?? {} };
      }
      const uidValidity = Number(mailbox.uidValidity);
      const prev = cursor?.imap?.[folder];
      const validityChanged = prev !== undefined && prev.uidValidity !== uidValidity;
      const lastUid = validityChanged ? 0 : (prev?.lastUid ?? 0);

      const envelopes: MailEnvelope[] = [];
      let maxUid = lastUid;
      if (mailbox.exists > 0) {
        for await (const msg of client.fetch(
          `${lastUid + 1}:*`,
          { uid: true, envelope: true, flags: true, internalDate: true },
          { uid: true },
        )) {
          if (msg.uid <= lastUid) continue; // `n:*` can echo the boundary
          const env = msg.envelope;
          const messageId = env?.messageId ?? `imap-${folder}-${msg.uid}`;
          envelopes.push({
            id: String(msg.uid),
            uid: msg.uid,
            messageId,
            threadKey: messageId,
            date: toIso(env?.date ?? msg.internalDate),
            from: formatEnvAddr(env?.from as EnvAddr[] | undefined),
            subject: env?.subject ?? '',
            flags: msg.flags ? [...msg.flags] : [],
            folder,
          });
          if (msg.uid > maxUid) maxUid = msg.uid;
        }
      }

      const newCursor: MailCursor = {
        ...(cursor ?? {}),
        imap: { ...(cursor?.imap ?? {}), [folder]: { uidValidity, lastUid: maxUid } },
      };
      return { envelopes, cursor: newCursor };
    } finally {
      lock.release();
    }
  }

  async fetchMessage(folder: string, id: string): Promise<MailMessage> {
    const uid = Number(id);
    const client = this.require();
    const lock = await client.getMailboxLock(folder);
    try {
      const msg = await client.fetchOne(
        String(uid),
        { uid: true, source: true, flags: true, internalDate: true },
        { uid: true },
      );
      if (!msg || !msg.source) {
        throw new Error(`imap message uid ${uid} not found in ${folder}`);
      }
      return parseRawMessage(msg.source, {
        folder,
        id,
        uid,
        flags: msg.flags ? [...msg.flags] : [],
        fallbackDate: msg.internalDate ? new Date(msg.internalDate).toISOString() : undefined,
      });
    } finally {
      lock.release();
    }
  }

  async send(from: string, mail: OutgoingMail): Promise<{ messageId: string }> {
    const smtp = this.cred.smtp;
    if (!smtp) {
      throw new Error('no SMTP configuration for this account; cannot send');
    }
    const secure = smtp.secure ?? false;
    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port ?? (secure ? 465 : 587),
      secure,
      auth: { user: smtp.user ?? this.cred.user, pass: smtp.pass ?? this.cred.pass },
    });
    try {
      const info = await transport.sendMail({
        from,
        to: mail.to,
        ...(mail.cc?.length ? { cc: mail.cc } : {}),
        ...(mail.bcc?.length ? { bcc: mail.bcc } : {}),
        subject: mail.subject,
        text: mail.bodyMarkdown,
        ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}),
        ...(mail.references?.length ? { references: mail.references } : {}),
      });
      return { messageId: info.messageId ?? '' };
    } finally {
      transport.close();
    }
  }

  async close(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.logout();
    } catch {
      // best-effort; force-close on failure
      try {
        this.client.close();
      } catch {
        /* ignore */
      }
    }
    this.client = null;
  }
}
