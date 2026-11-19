/**
 * Terminal PIN security utilities for Ventify Mobile.
 * Pure TypeScript so hashing, verification, legacy upgrade, and lockout logic
 * run deterministically across React Native (Hermes) and Node/Vitest.
 */

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 8;
export const PIN_FORMAT_REGEX = /^\d{4,8}$/;
export const PIN_MAX_ATTEMPTS = 5;
export const PIN_LOCKOUT_DURATION_MS = 30_000;
export const DEFAULT_PIN_ITERATIONS = 1000;

export interface StoredPinRecord {
  version: 1;
  hash: string;
  pinLength: number;
  updatedAt: number;
}

export interface ParsedStoredPin {
  hash: string;
  pinLength: number;
  isLegacyPlaintext: boolean;
}

export interface PinVerifyResult {
  valid: boolean;
  upgradedRecord: StoredPinRecord | null;
  pinLength: number;
}

export interface PinAttemptState {
  failedAttempts: number;
  lockoutUntil: number | null;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const SHA256_INIT = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function encodeUtf8(input: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(input);
  }
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    let code = input.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + (((code - 0xd800) << 10) | (next - 0xdc00));
        i += 1;
        bytes.push(
          0xf0 | (code >> 18),
          0x80 | ((code >> 12) & 0x3f),
          0x80 | ((code >> 6) & 0x3f),
          0x80 | (code & 0x3f)
        );
      } else {
        bytes.push(0xef, 0xbf, 0xbd);
      }
    } else {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Standard FIPS 180-4 SHA-256 digest returned as lowercase 64-char hex. */
export function sha256Hex(input: string): string {
  const bytes = encodeUtf8(input);
  const bitLen = bytes.length * 8;
  const totalLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(totalLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  const highBits = Math.floor(bitLen / 0x100000000);
  const lowBits = bitLen >>> 0;
  view.setUint32(totalLen - 8, highBits, false);
  view.setUint32(totalLen - 4, lowBits, false);

  const hash = new Uint32Array(SHA256_INIT);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = hash[0];
    let b = hash[1];
    let c = hash[2];
    let d = hash[3];
    let e = hash[4];
    let f = hash[5];
    let g = hash[6];
    let h = hash[7];

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  let out = '';
  for (let i = 0; i < 8; i += 1) {
    out += hash[i].toString(16).padStart(8, '0');
  }
  return out;
}

/** Validates that a PIN has 4 to 8 numeric ASCII digits. */
export function isValidPinFormat(pin: string): boolean {
  if (typeof pin !== 'string') return false;
  return PIN_FORMAT_REGEX.test(pin.trim());
}

/** Clamps a PIN length to the supported [4, 8] range. */
export function normalizePinLength(length: unknown): number {
  const num = Number(length);
  if (!Number.isInteger(num) || num < PIN_MIN_LENGTH) return PIN_MIN_LENGTH;
  if (num > PIN_MAX_LENGTH) return PIN_MAX_LENGTH;
  return num;
}

/** Trims and asserts valid 4-to-8 digit PIN format. */
export function assertValidPin(pin: string): string {
  const clean = typeof pin === 'string' ? pin.trim() : '';
  if (!PIN_FORMAT_REGEX.test(clean)) {
    throw new Error(`El PIN debe tener entre ${PIN_MIN_LENGTH} y ${PIN_MAX_LENGTH} dígitos numéricos.`);
  }
  return clean;
}

/** Constant-time string comparison to avoid timing leaks on PIN/hash checks. */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i += 1) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/** Generates a random hex salt using WebCrypto, expo-crypto, or safe entropy fallback. */
export function generatePinSalt(byteLength = 16): string {
  const size = Math.max(8, byteLength);
  const cryptoObj = (globalThis as { crypto?: { getRandomValues?: (arr: Uint8Array) => Uint8Array } }).crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    const buf = new Uint8Array(size);
    cryptoObj.getRandomValues(buf);
    return bytesToHex(buf);
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const expoCrypto = require('expo-crypto');
    if (typeof expoCrypto?.getRandomBytes === 'function') {
      const buf: Uint8Array = expoCrypto.getRandomBytes(size);
      return bytesToHex(buf);
    }
  } catch {
    // Expected in pure Node environments without expo-modules-core
  }

  const fallback = new Uint8Array(size);
  let seed = Date.now() ^ 0x9e3779b9;
  for (let i = 0; i < size; i += 1) {
    seed = (seed * 1664525 + 1013904223 + Math.floor(Math.random() * 256)) >>> 0;
    fallback[i] = seed & 0xff;
  }
  return bytesToHex(fallback);
}

const HASH_PATTERN = /^v1\$(\d+)\$([0-9a-f]+)\$([0-9a-f]{64})$/;

/** Checks whether a stored string already uses the salted v1 hash format. */
export function isHashedPin(value: string): boolean {
  return typeof value === 'string' && HASH_PATTERN.test(value.trim());
}

function stretchPinDigest(pin: string, salt: string, iterations: number): string {
  const safeIterations = Math.max(1, Math.min(iterations, 50_000));
  let digest = sha256Hex(`${salt}:${pin}`);
  for (let i = 1; i < safeIterations; i += 1) {
    digest = sha256Hex(`${salt}:${digest}`);
  }
  return digest;
}

/** Hashes a 4-8 digit PIN with a random per-PIN salt and key stretching. */
export function hashPin(
  pin: string,
  salt: string = generatePinSalt(16),
  iterations: number = DEFAULT_PIN_ITERATIONS
): string {
  const cleanPin = assertValidPin(pin);
  const cleanSalt = salt.trim().toLowerCase();
  if (!/^[0-9a-f]{16,}$/.test(cleanSalt)) {
    throw new Error('Salt inválido para el hash del PIN.');
  }
  const safeIterations = Math.max(1, Math.floor(iterations));
  const digest = stretchPinDigest(cleanPin, cleanSalt, safeIterations);
  return `v1$${safeIterations}$${cleanSalt}$${digest}`;
}

/** Creates a complete StoredPinRecord (hashed PIN + length metadata). */
export function createStoredPinRecord(
  pin: string,
  now: number = Date.now(),
  salt?: string
): StoredPinRecord {
  const cleanPin = assertValidPin(pin);
  return {
    version: 1,
    hash: hashPin(cleanPin, salt),
    pinLength: cleanPin.length,
    updatedAt: now,
  };
}

export function serializeStoredPinRecord(record: StoredPinRecord): string {
  return JSON.stringify(record);
}

/** Parses either a modern JSON StoredPinRecord, a raw v1 hash, or a legacy plaintext PIN. */
export function parseStoredPin(raw: string | null | undefined): ParsedStoredPin | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Partial<StoredPinRecord>;
      if (parsed && parsed.version === 1 && typeof parsed.hash === 'string' && isHashedPin(parsed.hash)) {
        return {
          hash: parsed.hash,
          pinLength: normalizePinLength(parsed.pinLength),
          isLegacyPlaintext: false,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  if (isHashedPin(trimmed)) {
    return {
      hash: trimmed,
      pinLength: PIN_MIN_LENGTH,
      isLegacyPlaintext: false,
    };
  }

  return {
    hash: trimmed,
    pinLength: normalizePinLength(trimmed.length),
    isLegacyPlaintext: true,
  };
}

/**
 * Verifies an entered PIN against a stored hash or legacy plaintext PIN.
 * When a legacy plaintext PIN matches, returns `upgradedRecord` so the caller can persist the hashed form.
 */
export function verifyStoredPin(
  enteredPin: string,
  storedRaw: string | null | undefined,
  now: number = Date.now()
): PinVerifyResult {
  const cleanEntered = typeof enteredPin === 'string' ? enteredPin.trim() : '';
  const parsed = parseStoredPin(storedRaw);
  if (!parsed || !cleanEntered) {
    return { valid: false, upgradedRecord: null, pinLength: parsed?.pinLength ?? PIN_MIN_LENGTH };
  }

  if (!parsed.isLegacyPlaintext) {
    const match = HASH_PATTERN.exec(parsed.hash);
    if (!match || !isValidPinFormat(cleanEntered)) {
      return { valid: false, upgradedRecord: null, pinLength: parsed.pinLength };
    }
    const iterations = Number(match[1]);
    const salt = match[2];
    const expectedDigest = match[3];
    const actualDigest = stretchPinDigest(cleanEntered, salt, iterations);
    const valid = constantTimeEqual(actualDigest, expectedDigest);
    return { valid, upgradedRecord: null, pinLength: parsed.pinLength };
  }

  // Legacy plaintext fallback (constant-time compare) + automatic hash upgrade on valid entry
  const valid = constantTimeEqual(cleanEntered, parsed.hash);
  if (!valid) {
    return { valid: false, upgradedRecord: null, pinLength: parsed.pinLength };
  }

  const upgradedRecord = isValidPinFormat(cleanEntered)
    ? createStoredPinRecord(cleanEntered, now)
    : null;
  return {
    valid: true,
    upgradedRecord,
    pinLength: upgradedRecord ? upgradedRecord.pinLength : parsed.pinLength,
  };
}

export function initialPinAttemptState(): PinAttemptState {
  return { failedAttempts: 0, lockoutUntil: null };
}

export function isPinLockedOut(state: PinAttemptState, now: number = Date.now()): boolean {
  return state.lockoutUntil !== null && now < state.lockoutUntil;
}

export function getPinCooldownRemainingMs(state: PinAttemptState, now: number = Date.now()): number {
  if (state.lockoutUntil === null || now >= state.lockoutUntil) return 0;
  return state.lockoutUntil - now;
}

/** Increments failed PIN attempts and engages a 30s lockout after 5 consecutive failures. */
export function registerFailedPinAttempt(
  state: PinAttemptState,
  now: number = Date.now()
): PinAttemptState {
  if (isPinLockedOut(state, now)) {
    return state;
  }
  const baseCount = state.lockoutUntil !== null && now >= state.lockoutUntil ? 0 : state.failedAttempts;
  const nextCount = baseCount + 1;
  if (nextCount >= PIN_MAX_ATTEMPTS) {
    return {
      failedAttempts: nextCount,
      lockoutUntil: now + PIN_LOCKOUT_DURATION_MS,
    };
  }
  return {
    failedAttempts: nextCount,
    lockoutUntil: null,
  };
}

export function resetPinAttemptState(): PinAttemptState {
  return initialPinAttemptState();
}
