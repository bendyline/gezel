/**
 * SPAKE2 (RFC 9382), ciphersuite SPAKE2-P256-SHA256-HKDF-HMAC: the password-
 * authenticated key exchange behind connect codes for remote serving.
 *
 * Why a PAKE: the code is 8 digits, so anything derived from it that crosses
 * the network (a hash, an HMAC) can be brute-forced offline in seconds by
 * whoever intercepted it. With SPAKE2 an active attacker learns only whether
 * the one code it guessed was right, once per protocol run, and the server
 * allows a handful of runs per code. Both device fingerprints go into the
 * transcript, so a successful run also proves each side is talking to the
 * identity it pinned — a man in the middle has to guess the code twice.
 *
 * The group arithmetic is plain BigInt over P-256 (Node's crypto exposes ECDH
 * but no point addition, which SPAKE2 needs). BigInt is not constant-time,
 * which RFC 9382 §7 asks for. What that exposes here is narrow: x and y are
 * fresh per run and never reused, w belongs to one short-lived single-use
 * code, and a run happens only when someone types a code. Anything moving
 * this onto long-lived secrets should switch to a constant-time library.
 *
 * Verified against all four RFC 9382 Appendix B test vectors (spake2.test.ts).
 */

import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

// ── P-256 ───────────────────────────────────────────────────────────────

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const A = P - 3n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
/** Order of the group (RFC 9382's p; called n here to keep P for the field). */
const N_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const G: Point = {
  x: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
  y: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
};

/** An affine point; null is the point at infinity. */
type Point = { x: bigint; y: bigint } | null;

function mod(a: bigint, m: bigint = P): bigint {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

function invert(a: bigint, m: bigint = P): bigint {
  let [oldR, r] = [mod(a, m), m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new Error('spake2: value has no inverse');
  return mod(oldS, m);
}

function modPow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return result;
}

function isOnCurve(pt: { x: bigint; y: bigint }): boolean {
  return mod(pt.y * pt.y - (pt.x * pt.x * pt.x + A * pt.x + B)) === 0n;
}

function add(p1: Point, p2: Point): Point {
  if (!p1) return p2;
  if (!p2) return p1;
  if (p1.x === p2.x) {
    if (mod(p1.y + p2.y) === 0n) return null;
    return double(p1);
  }
  const lambda = mod((p2.y - p1.y) * invert(p2.x - p1.x));
  const x = mod(lambda * lambda - p1.x - p2.x);
  return { x, y: mod(lambda * (p1.x - x) - p1.y) };
}

function double(pt: Point): Point {
  if (!pt || pt.y === 0n) return null;
  const lambda = mod((3n * pt.x * pt.x + A) * invert(2n * pt.y));
  const x = mod(lambda * lambda - 2n * pt.x);
  return { x, y: mod(lambda * (pt.x - x) - pt.y) };
}

function negate(pt: Point): Point {
  return pt ? { x: pt.x, y: mod(-pt.y) } : null;
}

/** Montgomery ladder: one add and one double per bit, whatever the bit. */
function multiply(pt: Point, k: bigint): Point {
  let r0: Point = null;
  let r1: Point = pt;
  for (let i = 255; i >= 0; i--) {
    if ((k >> BigInt(i)) & 1n) {
      r0 = add(r0, r1);
      r1 = double(r1);
    } else {
      r1 = add(r0, r1);
      r0 = double(r0);
    }
  }
  return r0;
}

function toBytes(n: bigint, length = 32): Buffer {
  return Buffer.from(n.toString(16).padStart(length * 2, '0'), 'hex');
}

function fromBytes(b: Buffer): bigint {
  return b.length === 0 ? 0n : BigInt(`0x${b.toString('hex')}`);
}

/** SEC1 uncompressed encoding, the form RFC 9382 puts on the wire for P-256. */
function encodePoint(pt: Point): Buffer {
  if (!pt) throw new Error('spake2: cannot encode the point at infinity');
  return Buffer.concat([Buffer.from([4]), toBytes(pt.x), toBytes(pt.y)]);
}

/**
 * Parses a peer's point and checks it is in the group (RFC 9382 §7: an
 * endpoint MUST abort on a value that is not). P-256 has cofactor 1, so a
 * finite point on the curve is in the prime-order group.
 */
function decodePoint(bytes: Buffer): { x: bigint; y: bigint } {
  if (bytes.length === 65 && bytes[0] === 4) {
    const pt = { x: fromBytes(bytes.subarray(1, 33)), y: fromBytes(bytes.subarray(33)) };
    if (pt.x >= P || pt.y >= P || !isOnCurve(pt)) throw new Spake2Error('point is not on P-256');
    return pt;
  }
  if (bytes.length === 33 && (bytes[0] === 2 || bytes[0] === 3)) {
    const x = fromBytes(bytes.subarray(1));
    if (x >= P) throw new Spake2Error('point is not on P-256');
    // P ≡ 3 (mod 4), so a square root is a single exponentiation.
    const y = modPow(mod(x * x * x + A * x + B), (P + 1n) / 4n);
    const pt = { x, y: (y & 1n) === BigInt(bytes[0]! & 1) ? y : mod(-y) };
    if (!isOnCurve(pt)) throw new Spake2Error('point is not on P-256');
    return pt;
  }
  throw new Spake2Error('point encoding is not SEC1 P-256');
}

/** RFC 9382 §6, P-256: M and N, generated from the curve OID with no known discrete log. */
const M = decodePoint(
  Buffer.from('02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f', 'hex'),
);
const N = decodePoint(
  Buffer.from('03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49', 'hex'),
);

// ── Protocol ────────────────────────────────────────────────────────────

export class Spake2Error extends Error {}

export type Spake2Role = 'A' | 'B';

export interface Spake2State {
  role: Spake2Role;
  w: bigint;
  scalar: bigint;
  share: Buffer;
}

export interface Spake2Keys {
  /** The shared secret (RFC 9382's Ke). */
  ke: Buffer;
  /** A's confirmation message, cA = MAC(KcA, TT). */
  confirmA: Buffer;
  /** B's confirmation message, cB = MAC(KcB, TT). */
  confirmB: Buffer;
}

/** A scalar uniform in [1, n), by rejection sampling (RFC 9382 §7). */
function randomScalar(): bigint {
  for (;;) {
    const k = fromBytes(randomBytes(32));
    if (k > 0n && k < N_ORDER) return k;
  }
}

/**
 * w from a password: a hash 64+ bits wider than the group order, reduced, so
 * the reduction adds no measurable bias (RFC 9382 §3.2). Not a memory-hard
 * function, which the RFC recommends: the codes this serves are random,
 * single-use and live for minutes, and the only attack on them is online.
 */
export function passwordScalar(password: string, context: string): bigint {
  const digest = createHash('sha512').update(context).update('\0').update(password).digest();
  return mod(fromBytes(digest), N_ORDER);
}

/** Round one: pick a fresh scalar and compute this side's share (pA or pB). */
export function spake2Start(
  role: Spake2Role,
  w: bigint,
  opts: { scalar?: bigint } = {},
): Spake2State {
  const scalar = opts.scalar ?? randomScalar();
  const blind = multiply(role === 'A' ? M : N, w);
  return { role, w, scalar, share: encodePoint(add(multiply(G, scalar), blind)) };
}

function lengthPrefixed(bytes: Buffer): Buffer {
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(bytes.length));
  return Buffer.concat([len, bytes]);
}

/**
 * Round two: combine the peer's share into K, build the transcript, and derive
 * the shared secret and both confirmation messages. Throws
 * {@link Spake2Error} when the peer's share is not a valid group element.
 * Neither side may treat the exchange as done until it has checked the
 * other's confirmation with {@link confirmationsMatch}.
 */
export function spake2Finish(
  state: Spake2State,
  opts: { idA: string | Buffer; idB: string | Buffer; peerShare: Buffer; aad?: string | Buffer },
): Spake2Keys {
  const peer = decodePoint(opts.peerShare);
  const unblind = negate(multiply(state.role === 'A' ? N : M, state.w));
  const k = multiply(add(peer, unblind), state.scalar);
  if (!k) throw new Spake2Error('shared point is the identity');
  const pA = state.role === 'A' ? state.share : opts.peerShare;
  const pB = state.role === 'A' ? opts.peerShare : state.share;
  const transcript = Buffer.concat([
    lengthPrefixed(Buffer.from(opts.idA)),
    lengthPrefixed(Buffer.from(opts.idB)),
    lengthPrefixed(pA),
    lengthPrefixed(pB),
    lengthPrefixed(encodePoint(k)),
    lengthPrefixed(toBytes(state.w)),
  ]);
  const hash = createHash('sha256').update(transcript).digest();
  const ke = hash.subarray(0, 16);
  const ka = hash.subarray(16);
  const info = Buffer.concat([Buffer.from('ConfirmationKeys'), Buffer.from(opts.aad ?? '')]);
  const confirmationKeys = Buffer.from(hkdfSync('sha256', ka, Buffer.alloc(0), info, 32));
  const mac = (key: Buffer) => createHmac('sha256', key).update(transcript).digest();
  return {
    ke: Buffer.from(ke),
    confirmA: mac(confirmationKeys.subarray(0, 16)),
    confirmB: mac(confirmationKeys.subarray(16)),
  };
}

export function confirmationsMatch(expected: Buffer, received: Buffer): boolean {
  return expected.length === received.length && timingSafeEqual(expected, received);
}
