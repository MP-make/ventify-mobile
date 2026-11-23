/**
 * Checks live network reachability via NetInfo rather than relying solely on
 * potentially stale React state (e.g. after Doze/background resume or network drops).
 * Uses dynamic import so Node/Vitest unit tests without a NetInfo mock never fail on
 * package-level Flow/TypeScript syntax when importing service modules.
 */
export async function checkIsOnlineLive(fallbackOnline?: boolean): Promise<boolean> {
  try {
    const netInfoMod: any = await import('@react-native-community/netinfo');
    const netInfo = netInfoMod?.default ?? netInfoMod;
    if (!netInfo || typeof netInfo.fetch !== 'function') {
      return fallbackOnline !== undefined ? Boolean(fallbackOnline) : true;
    }
    const state = await netInfo.fetch();
    return Boolean(state.isConnected && state.isInternetReachable !== false);
  } catch {
    return fallbackOnline !== undefined ? Boolean(fallbackOnline) : true;
  }
}

/**
 * Races an async operation against a timeout so uncached Firestore writes or
 * transactions never hang modals indefinitely on dead/blackhole networks.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  timeoutMessage: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }
}

/**
 * Fail-fast online guard for Firestore mutations that require server consensus
 * (runTransaction, setDoc/updateDoc under memoryLocalCache, or API calls).
 */
export async function assertOnlineForWrite(
  actionLabel: string,
  fallbackOnline?: boolean
): Promise<void> {
  const online = await checkIsOnlineLive(fallbackOnline);
  if (!online) {
    throw new Error(`Sin conexión a internet. Conéctate para ${actionLabel}.`);
  }
}
