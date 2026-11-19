import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PIN_LOCKOUT_DURATION_MS,
  PIN_MAX_ATTEMPTS,
  assertValidPin,
  constantTimeEqual,
  createStoredPinRecord,
  getPinCooldownRemainingMs,
  hashPin,
  initialPinAttemptState,
  isHashedPin,
  isPinLockedOut,
  isValidPinFormat,
  parseStoredPin,
  registerFailedPinAttempt,
  resetPinAttemptState,
  serializeStoredPinRecord,
  sha256Hex,
  verifyStoredPin,
} from '../pin-mobile';

describe('pin-mobile security & lockout', () => {
  it('computes standard SHA-256 matching Node crypto', () => {
    for (const input of ['', '1234', 'abc', 'salt:56789012', 'ventify-pin-v1-check-utf8-ñ']) {
      const expected = createHash('sha256').update(input, 'utf8').digest('hex');
      expect(sha256Hex(input)).toBe(expected);
    }
  });

  it('validates 4-to-8 numeric digits strictly', () => {
    expect(isValidPinFormat('1234')).toBe(true);
    expect(isValidPinFormat('00000000')).toBe(true);
    expect(isValidPinFormat(' 98765 ')).toBe(true);

    expect(isValidPinFormat('123')).toBe(false);
    expect(isValidPinFormat('123456789')).toBe(false);
    expect(isValidPinFormat('12a4')).toBe(false);
    expect(isValidPinFormat('')).toBe(false);
    expect(() => assertValidPin('12')).toThrow();
    expect(() => assertValidPin('123456789')).toThrow();
    expect(assertValidPin(' 456789 ')).toBe('456789');
  });

  it('hashes with unique random salt and verifies in constant time', () => {
    const recordA = createStoredPinRecord('246810', 1000);
    const recordB = createStoredPinRecord('246810', 1000);

    expect(isHashedPin(recordA.hash)).toBe(true);
    expect(recordA.pinLength).toBe(6);
    expect(recordA.hash).not.toBe(recordB.hash);
    expect(recordA.hash).not.toContain('246810');

    const serialized = serializeStoredPinRecord(recordA);
    expect(verifyStoredPin('246810', serialized)).toEqual({
      valid: true,
      upgradedRecord: null,
      pinLength: 6,
    });
    expect(verifyStoredPin('246811', serialized)).toEqual({
      valid: false,
      upgradedRecord: null,
      pinLength: 6,
    });
  });

  it('compares unequal and equal strings with constantTimeEqual', () => {
    expect(constantTimeEqual('abcdef', 'abcdef')).toBe(true);
    expect(constantTimeEqual('abcdef', 'abcdeg')).toBe(false);
    expect(constantTimeEqual('abcd', 'abcdef')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('', 'a')).toBe(false);
  });

  it('verifies legacy plaintext PINs seamlessly and returns an upgraded salted hash', () => {
    const parsedLegacy = parseStoredPin('567890');
    expect(parsedLegacy).toEqual({
      hash: '567890',
      pinLength: 6,
      isLegacyPlaintext: true,
    });

    const wrong = verifyStoredPin('000000', '567890', 5000);
    expect(wrong.valid).toBe(false);
    expect(wrong.upgradedRecord).toBeNull();

    const right = verifyStoredPin('567890', '567890', 5000);
    expect(right.valid).toBe(true);
    expect(right.pinLength).toBe(6);
    expect(right.upgradedRecord).not.toBeNull();
    expect(isHashedPin(right.upgradedRecord!.hash)).toBe(true);

    const upgradedSerialized = serializeStoredPinRecord(right.upgradedRecord!);
    expect(verifyStoredPin('567890', upgradedSerialized).valid).toBe(true);
    expect(verifyStoredPin('567890', upgradedSerialized).upgradedRecord).toBeNull();
  });

  it('rejects malformed stored records and deterministic salt hashing works', () => {
    expect(parseStoredPin(null)).toBeNull();
    expect(parseStoredPin('')).toBeNull();
    expect(parseStoredPin('{"version":1,"hash":"not-a-hash"}')).toBeNull();
    expect(parseStoredPin('{broken')).toBeNull();

    const h1 = hashPin('1357', '00112233445566778899aabbccddeeff', 10);
    const h2 = hashPin('1357', '00112233445566778899aabbccddeeff', 10);
    expect(h1).toBe(h2);
    expect(verifyStoredPin('1357', h1).valid).toBe(true);
  });

  it('enforces 5 failed attempts -> 30s lockout and resets after cooldown or success', () => {
    const t0 = 1_000_000;
    let state = initialPinAttemptState();

    for (let i = 1; i < PIN_MAX_ATTEMPTS; i += 1) {
      state = registerFailedPinAttempt(state, t0 + i * 100);
      expect(state.failedAttempts).toBe(i);
      expect(state.lockoutUntil).toBeNull();
      expect(isPinLockedOut(state, t0 + i * 100)).toBe(false);
    }

    state = registerFailedPinAttempt(state, t0 + 1000);
    expect(state.failedAttempts).toBe(PIN_MAX_ATTEMPTS);
    expect(state.lockoutUntil).toBe(t0 + 1000 + PIN_LOCKOUT_DURATION_MS);
    expect(isPinLockedOut(state, t0 + 1000)).toBe(true);
    expect(getPinCooldownRemainingMs(state, t0 + 16_000)).toBe(15_000);

    // Additional failed calls during active cooldown do not shift lockoutUntil
    const duringCooldown = registerFailedPinAttempt(state, t0 + 16_000);
    expect(duringCooldown).toEqual(state);

    // Cooldown expires after 30_000ms
    const afterCooldown = t0 + 1000 + PIN_LOCKOUT_DURATION_MS;
    expect(isPinLockedOut(state, afterCooldown)).toBe(false);
    expect(getPinCooldownRemainingMs(state, afterCooldown)).toBe(0);

    // Next failure after cooldown restarts attempt counter cleanly
    const freshCycle = registerFailedPinAttempt(state, afterCooldown);
    expect(freshCycle).toEqual({ failedAttempts: 1, lockoutUntil: null });

    // Successful unlock resets attempts
    expect(resetPinAttemptState()).toEqual({ failedAttempts: 0, lockoutUntil: null });
  });
});
