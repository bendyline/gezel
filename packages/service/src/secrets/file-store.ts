import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { secretsFile, secretsKeyFile } from '@bendyline/gezel/paths';
import { writeFileAtomic } from '../fs/atomic.js';
import {
  type SecretKey,
  type SecretStore,
  type SecretStoreBackend,
  SecretStoreCorruptError,
  stringifySecretKey,
  toolsetKeyPrefix,
} from './types.js';

/**
 * Encrypted-file SecretStore. Not as strong as the OS keyring — assumes
 * the key file on disk is protected by filesystem permissions — but
 * identical to the threat model every other local desktop-app credential
 * store uses when no keyring is available.
 *
 * KNOWN LIMITATION (tracked follow-up): the AES key (`secrets.key`) lives
 * next to the ciphertext (`secrets.enc`) under the same 0600 perms, so the
 * encryption adds little over the file permissions themselves — anyone who
 * can copy the directory (a stolen `~/.gezel`, a backup, a cloud-synced
 * external folder) gets both halves. Closing this means binding the key to
 * something the copier lacks: an OS-keychain-stored seed, a machine-id +
 * user-scoped KDF, or a user passphrase. Until then, treat `secrets.enc`
 * as plaintext-equivalent and keep it out of any folder-sync target.
 *
 * File layout (`secrets.enc`):
 *   { "version": 1, "entries": { "<key>": "<nonce||ciphertext||tag base64>" } }
 *
 * Each entry is encrypted independently with a fresh 12-byte nonce so
 * reading/writing one key doesn't require re-encrypting the whole file
 * and concurrent writers touching different keys don't corrupt each
 * other's data.
 */
export class FileSecretStore implements SecretStore {
  readonly backend: SecretStoreBackend = 'file';

  private key: Buffer | null = null;
  private cache: Map<string, string> | null = null;
  /** Serializes writes so concurrent set/delete calls don't tear the file. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly home: string) {}

  async get(key: SecretKey): Promise<string | null> {
    const map = await this.load();
    return map.get(stringifySecretKey(key)) ?? null;
  }

  async has(key: SecretKey): Promise<boolean> {
    const map = await this.load();
    return map.has(stringifySecretKey(key));
  }

  async set(key: SecretKey, value: string): Promise<void> {
    await this.mutate((map) => {
      map.set(stringifySecretKey(key), value);
    });
  }

  async delete(key: SecretKey): Promise<void> {
    await this.mutate((map) => {
      map.delete(stringifySecretKey(key));
    });
  }

  async listForToolset(toolsetId: string): Promise<string[]> {
    const map = await this.load();
    const prefix = toolsetKeyPrefix(toolsetId);
    const fieldIds: string[] = [];
    for (const k of map.keys()) {
      if (k.startsWith(prefix)) fieldIds.push(k.slice(prefix.length));
    }
    return fieldIds;
  }

  /** Internal backend-migration seam. Values remain encrypted until read here. */
  async exportEntries(): Promise<Map<string, string>> {
    return new Map(await this.load());
  }

  async importEntries(entries: ReadonlyMap<string, string>, overwrite = false): Promise<void> {
    await this.mutate((current) => {
      for (const [name, value] of entries) {
        if (overwrite || !current.has(name)) current.set(name, value);
      }
    });
  }

  private async mutate(fn: (map: Map<string, string>) => void): Promise<void> {
    const next = this.writeChain.then(async () => {
      const map = await this.load();
      fn(map);
      await this.save(map);
    });
    this.writeChain = next.catch(() => undefined);
    await next;
  }

  private async load(): Promise<Map<string, string>> {
    if (this.cache) return this.cache;
    const file = secretsFile(this.home);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new SecretStoreCorruptError(`[secrets] cannot read ${file}`, { cause: error });
      }
      this.cache = new Map();
      return this.cache;
    }
    const k = await this.ensureKey();
    const parsed = parseEncryptedSecrets(raw);
    const out = new Map<string, string>();
    for (const [name, blob] of Object.entries(parsed.entries)) {
      out.set(name, decryptString(k, blob));
    }
    this.cache = out;
    return out;
  }

  private async save(map: Map<string, string>): Promise<void> {
    const k = await this.ensureKey();
    const entries: Record<string, string> = {};
    for (const [name, value] of map) {
      entries[name] = encryptString(k, value);
    }
    const file = secretsFile(this.home);
    await mkdir(dirname(file), { recursive: true });
    await writeFileAtomic(file, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, {
      mode: 0o600,
    });
    await tryChmod600(file);
    this.cache = map;
  }

  private async ensureKey(): Promise<Buffer> {
    if (this.key) return this.key;
    const keyFile = secretsKeyFile(this.home);
    try {
      const buf = await readFile(keyFile);
      if (buf.length !== 32) {
        throw new Error(`[secrets] key file has wrong length ${buf.length}`);
      }
      this.key = buf;
      return buf;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const buf = randomBytes(32);
      await mkdir(dirname(keyFile), { recursive: true });
      await writeFileAtomic(keyFile, buf, { mode: 0o600 });
      await tryChmod600(keyFile);
      this.key = buf;
      return buf;
    }
  }
}

function encryptString(key: Buffer, plaintext: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ct, tag]).toString('base64');
}

function decryptString(key: Buffer, blob: string): string {
  const buf = Buffer.from(blob, 'base64');
  if (buf.length < 12 + 16) {
    throw new Error('[secrets] ciphertext blob too short');
  }
  const nonce = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

async function tryChmod600(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    await chmod(path, 0o600);
  } catch {
    // best-effort; some filesystems (e.g. FAT) don't support chmod
  }
}

/** Read only a legacy identity entry, without constructing a credential store,
 * decrypting other entries, or creating/replacing an encryption key. */
export async function readFileIdentityKey(
  home: string,
  identity: Extract<SecretKey, { kind: 'deviceIdentity' }>,
): Promise<string | null> {
  const parsed = parseEncryptedSecrets(await readFile(secretsFile(home), 'utf8'));
  const blob = parsed.entries[stringifySecretKey(identity)];
  if (blob === undefined) return null;
  const key = await readFile(secretsKeyFile(home));
  if (key.length !== 32)
    throw new SecretStoreCorruptError('[secrets] invalid identity encryption key');
  return decryptString(key, blob);
}

function parseEncryptedSecrets(raw: string): { version: number; entries: Record<string, string> } {
  let parsed: { version: number; entries: Record<string, string> };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch (cause) {
    throw new SecretStoreCorruptError('[secrets] secrets.enc is malformed JSON', { cause });
  }
  if (
    !parsed ||
    parsed.version !== 1 ||
    !parsed.entries ||
    typeof parsed.entries !== 'object' ||
    Array.isArray(parsed.entries)
  ) {
    throw new SecretStoreCorruptError('[secrets] unsupported or invalid secrets.enc format');
  }
  return parsed;
}
