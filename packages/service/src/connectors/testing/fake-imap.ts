/**
 * An in-memory IMAP server for mail-adapter tests, exposed through the slice
 * of imapflow's `ImapFlow` surface the IMAP provider uses
 * (`mail/providers/imap.ts` `ImapClient`): connect / usable / on / list /
 * getMailboxLock + `mailbox` {uidValidity, uidNext, exists} / search / fetch /
 * fetchOne / append / logout / close. Plus a capturing SMTP transport.
 *
 * Behaviors modeled because the provider depends on them:
 *   - a wrong password fails `connect()` the way imapflow does
 *     (`authenticationFailed: true`, the server's response text);
 *   - UIDs are strictly increasing per mailbox and `UIDNEXT` predicts the next;
 *   - `UID SEARCH n:*` echoes the highest UID when n is past it (RFC 3501);
 *   - `SEARCH SINCE` compares the internal date by calendar day;
 *   - `resetUidValidity` renumbers a mailbox under a new UIDVALIDITY;
 *   - an expunged UID makes `fetchOne` answer `false`;
 *   - special-use flags on `list()` (RFC 6154 `\Drafts`, `\Sent`).
 */

import type { FixtureMessage } from './mime.js';
import { buildMime } from './mime.js';

export interface FakeImapMessage {
  uid: number;
  raw: Buffer;
  flags: Set<string>;
  internalDate: Date;
}

export interface FakeImapMailbox {
  path: string;
  name: string;
  specialUse?: string;
  uidValidity: bigint;
  uidNext: number;
  messages: FakeImapMessage[];
}

interface ClientOptions {
  host: string;
  port: number;
  auth: { user: string; pass: string };
}

type SearchQuery = { since?: Date | string; uid?: string; all?: boolean };

/** Parse an IMAP sequence set (`1:*`, `4,7:9`) against the mailbox's highest UID. */
function inSequenceSet(set: string, uid: number, max: number): boolean {
  for (const part of set.split(',')) {
    const [a, b] = part.split(':');
    const lo = a === '*' ? max : Number(a);
    const hi = b === undefined ? lo : b === '*' ? max : Number(b);
    if (uid >= Math.min(lo, hi) && uid <= Math.max(lo, hi)) return true;
  }
  return false;
}

const dayStart = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

export class FakeImapServer {
  readonly mailboxes = new Map<string, FakeImapMailbox>();
  readonly logins: { user: string; ok: boolean }[] = [];
  /** Commands the clients sent, for asserting what the provider asked. */
  readonly commands: string[] = [];
  /** Locks taken and released (a leaked lock wedges a real connection). */
  locksHeld = 0;
  user: string;
  pass: string;
  /** Refuse connections outright (a down server). */
  unreachable = false;
  /** Advertise UIDPLUS (APPEND returns the new UID). */
  uidPlus = true;
  private validity = 1_700_000_000n;

  constructor(
    opts: {
      user?: string;
      pass?: string;
      mailboxes?: { path: string; specialUse?: string }[];
    } = {},
  ) {
    this.user = opts.user ?? 'me@example.com';
    this.pass = opts.pass ?? 'app-password-1234';
    for (const mb of opts.mailboxes ?? [
      { path: 'INBOX', specialUse: '\\Inbox' },
      { path: 'Drafts', specialUse: '\\Drafts' },
      { path: 'Sent', specialUse: '\\Sent' },
      { path: 'Archive', specialUse: '\\Archive' },
    ]) {
      this.addMailbox(mb.path, mb.specialUse);
    }
  }

  addMailbox(path: string, specialUse?: string): FakeImapMailbox {
    const mb: FakeImapMailbox = {
      path,
      name: path.split('/').pop() ?? path,
      ...(specialUse ? { specialUse } : {}),
      uidValidity: this.validity++,
      uidNext: 1,
      messages: [],
    };
    this.mailboxes.set(path, mb);
    return mb;
  }

  private must(path: string): FakeImapMailbox {
    const mb = this.mailboxes.get(path);
    if (!mb) throw new Error(`Mailbox doesn't exist: ${path}`);
    return mb;
  }

  /** Deliver a message; returns its UID. */
  addMessage(
    path: string,
    fixture: FixtureMessage = {},
    opts: { flags?: string[]; internalDate?: Date } = {},
  ): number {
    const mb = this.must(path);
    const date = fixture.date ?? new Date().toISOString();
    const uid = mb.uidNext++;
    mb.messages.push({
      uid,
      raw: buildMime({ ...fixture, date }),
      flags: new Set(opts.flags ?? []),
      internalDate: opts.internalDate ?? new Date(date),
    });
    return uid;
  }

  expunge(path: string, uid: number): void {
    const mb = this.must(path);
    mb.messages = mb.messages.filter((m) => m.uid !== uid);
  }

  /** The server rebuilt the mailbox: new UIDVALIDITY, every message renumbered. */
  resetUidValidity(path: string): void {
    const mb = this.must(path);
    mb.uidValidity = this.validity++;
    mb.uidNext = 1;
    for (const m of mb.messages) m.uid = mb.uidNext++;
  }

  /** The imapflow-shaped client factory to hand the provider. */
  readonly createClient = (options: ClientOptions): FakeImapClient =>
    new FakeImapClient(this, options);

  connect(options: ClientOptions): void {
    if (this.unreachable) {
      throw Object.assign(new Error(`connect ECONNREFUSED ${options.host}:${options.port}`), {
        code: 'ECONNREFUSED',
      });
    }
    const ok = options.auth.user === this.user && options.auth.pass === this.pass;
    this.logins.push({ user: options.auth.user, ok });
    if (!ok) {
      throw Object.assign(new Error('Command failed'), {
        authenticationFailed: true,
        serverResponseCode: 'AUTHENTICATIONFAILED',
        response: 'Invalid credentials (Failure)',
      });
    }
  }

  mailbox(path: string): FakeImapMailbox {
    return this.must(path);
  }
}

export class FakeImapClient {
  usable = false;
  mailbox:
    | false
    | { path: string; uidValidity: bigint; uidNext: number; exists: number; specialUse?: string } =
    false;
  private selected: FakeImapMailbox | null = null;
  private readonly listeners: ((err: Error) => void)[] = [];

  constructor(
    private readonly server: FakeImapServer,
    readonly options: ClientOptions,
  ) {}

  on(_event: 'error', listener: (err: Error) => void): this {
    this.listeners.push(listener);
    return this;
  }

  async connect(): Promise<void> {
    this.server.connect(this.options);
    this.usable = true;
  }

  private live(): void {
    if (!this.usable) throw new Error('Connection not available');
  }

  async list() {
    this.live();
    this.server.commands.push('LIST');
    return [...this.server.mailboxes.values()].map((mb) => ({
      path: mb.path,
      pathAsListed: mb.path,
      name: mb.name,
      delimiter: '/',
      parent: [] as string[],
      parentPath: '',
      flags: new Set<string>(mb.specialUse ? [mb.specialUse] : []),
      ...(mb.specialUse ? { specialUse: mb.specialUse } : {}),
      listed: true,
      subscribed: true,
    }));
  }

  async getMailboxLock(path: string): Promise<{ path: string; release(): void }> {
    this.live();
    this.server.commands.push(`SELECT ${path}`);
    const mb = this.server.mailbox(path);
    this.selected = mb;
    this.mailbox = {
      path: mb.path,
      uidValidity: mb.uidValidity,
      uidNext: mb.uidNext,
      exists: mb.messages.length,
      ...(mb.specialUse ? { specialUse: mb.specialUse } : {}),
    };
    this.server.locksHeld++;
    let released = false;
    return {
      path,
      release: () => {
        if (!released) {
          released = true;
          this.server.locksHeld--;
        }
      },
    };
  }

  private requireSelected(): FakeImapMailbox {
    if (!this.selected) throw new Error('No mailbox selected');
    return this.selected;
  }

  async search(query: SearchQuery, options: { uid?: boolean } = {}): Promise<number[] | false> {
    this.live();
    const mb = this.requireSelected();
    if (!options.uid) throw new Error('FakeImapClient models UID SEARCH only');
    this.server.commands.push(`UID SEARCH ${JSON.stringify(query)}`);
    const max = mb.messages.reduce((n, m) => Math.max(n, m.uid), 0);
    let hits = mb.messages;
    if (query.since !== undefined) {
      const since = dayStart(new Date(query.since));
      hits = hits.filter((m) => dayStart(m.internalDate) >= since);
    }
    if (query.uid !== undefined) {
      const set = query.uid;
      hits = hits.filter((m) => inSequenceSet(set, m.uid, max));
      // `n:*` with n past the highest UID still matches the highest message.
      if (hits.length === 0 && /:\*$/.test(set) && max > 0) {
        hits = mb.messages.filter((m) => m.uid === max);
      }
    }
    return hits.map((m) => m.uid).sort((a, b) => a - b);
  }

  async *fetch(
    range: string | number[],
    _query: Record<string, unknown>,
    options: { uid?: boolean } = {},
  ): AsyncIterableIterator<{
    uid: number;
    source: Buffer;
    flags: Set<string>;
    internalDate: Date;
  }> {
    this.live();
    const mb = this.requireSelected();
    if (!options.uid) throw new Error('FakeImapClient models UID FETCH only');
    const max = mb.messages.reduce((n, m) => Math.max(n, m.uid), 0);
    for (const m of mb.messages) {
      const hit = Array.isArray(range) ? range.includes(m.uid) : inSequenceSet(range, m.uid, max);
      if (hit)
        yield { uid: m.uid, source: m.raw, flags: new Set(m.flags), internalDate: m.internalDate };
    }
  }

  async fetchOne(
    range: string,
    _query: Record<string, unknown>,
    options: { uid?: boolean } = {},
  ): Promise<false | { uid: number; source: Buffer; flags: Set<string>; internalDate: Date }> {
    this.live();
    const mb = this.requireSelected();
    if (!options.uid) throw new Error('FakeImapClient models UID FETCH only');
    this.server.commands.push(`UID FETCH ${range}`);
    const m = mb.messages.find((x) => x.uid === Number(range));
    if (!m) return false;
    return { uid: m.uid, source: m.raw, flags: new Set(m.flags), internalDate: m.internalDate };
  }

  async append(
    path: string,
    content: Buffer | string,
    flags: string[] = [],
    idate?: Date | string,
  ): Promise<false | { destination: string; uid?: number; uidValidity?: bigint }> {
    this.live();
    this.server.commands.push(`APPEND ${path}`);
    const mb = this.server.mailbox(path);
    const uid = mb.uidNext++;
    mb.messages.push({
      uid,
      raw: Buffer.isBuffer(content) ? content : Buffer.from(content),
      flags: new Set(flags),
      internalDate: idate ? new Date(idate) : new Date(),
    });
    return {
      destination: path,
      ...(this.server.uidPlus ? { uid, uidValidity: mb.uidValidity } : {}),
    };
  }

  async logout(): Promise<void> {
    this.usable = false;
    this.selected = null;
    this.mailbox = false;
  }

  close(): void {
    this.usable = false;
  }
}

/** A capturing SMTP transport factory (stands in for `nodemailer.createTransport`). */
export class FakeSmtp {
  readonly transports: object[] = [];
  readonly sent: Record<string, unknown>[] = [];
  closed = 0;
  private n = 0;

  readonly createTransport = (options: object) => {
    this.transports.push(options);
    return {
      sendMail: async (mail: Record<string, unknown>) => {
        this.sent.push(mail);
        return { messageId: `<smtp-${++this.n}@fake.smtp>` };
      },
      close: () => {
        this.closed++;
      },
    };
  };
}
