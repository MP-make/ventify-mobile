/** Independent sources start together; either may use its existing fallback. */
export function loadIdentitySources<Claims, Profile>(
  readClaims: () => Promise<Claims>,
  readProfile: () => Promise<Profile>,
): Promise<[PromiseSettledResult<Claims>, PromiseSettledResult<Profile>]> {
  return Promise.allSettled([readClaims(), readProfile()]);
}

/** Auth state and the login screen may request the same profile concurrently. */
export function createProfileResolutionGate() {
  const pending = new Map<string, Promise<string | null>>();
  return (uid: string, load: () => Promise<string | null>): Promise<string | null> => {
    const existing = pending.get(uid);
    if (existing) return existing;
    const request = load().finally(() => {
      if (pending.get(uid) === request) pending.delete(uid);
    });
    pending.set(uid, request);
    return request;
  };
}
