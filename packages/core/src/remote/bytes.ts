/**
 * Byte helpers for the remote-pairing code that runs in both Node and a phone
 * WebView, where `Buffer` does not exist.
 */

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error('not a hex string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** A standalone copy for WebCrypto, which takes an ArrayBuffer rather than a view into one. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

/** WebCrypto, which both Node and a phone WebView provide. */
export function webCrypto() {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('this host has no WebCrypto');
  return subtle;
}

/** Equal-length comparison whose time does not depend on where the inputs differ. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** The DER bytes inside a PEM block (`-----BEGIN …-----`). */
export function pemToDer(pem: string): Uint8Array {
  const body = pem
    .split('\n')
    .filter((line) => !line.startsWith('-----') && line.trim().length > 0)
    .join('');
  return base64ToBytes(body.replace(/\s+/g, ''));
}

export function derToPem(der: Uint8Array, label: string): string {
  const b64 = bytesToBase64(der);
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}
