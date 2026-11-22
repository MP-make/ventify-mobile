import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CatalogCacheStorage } from './product-catalog-cache';

export interface NativeKVStorage extends CatalogCacheStorage {
  readonly isSyncCapable: boolean;
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  multiRemove(keys: string[]): Promise<void>;
  getItemSync(key: string): string | null;
  setItemSync(key: string, value: string): void;
  removeItemSync(key: string): void;
  trim?: () => Promise<void>;
}

const MULTI_REMOVE_YIELD_CHUNK = 20;
const yieldMultiRemove = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type MMKVInstance = {
  getString: (key: string) => string | undefined;
  set: (key: string, value: string | boolean | number) => void;
  delete: (key: string) => void;
  trim?: () => void;
  clearAll?: () => void;
};

type MMKVConstructor = new (options?: { id: string }) => MMKVInstance;

let MMKVClass: MMKVConstructor | null = null;
let mmkvResolved = false;

function resolveMMKVConstructor(): MMKVConstructor | null {
  if (mmkvResolved) return MMKVClass;
  mmkvResolved = true;
  try {
    // Dynamic require so bundlers or Node/Vitest don't fail at module load
    const mmkvModule = require('react-native-mmkv');
    const Candidate: MMKVConstructor = mmkvModule.MMKV || mmkvModule.default?.MMKV;
    if (typeof Candidate === 'function') {
      MMKVClass = Candidate;
      return MMKVClass;
    }
  } catch {
    // JSI not available (Node/Vitest, Web, or environment without native binary)
  }
  MMKVClass = null;
  return null;
}

function createAsyncStorageFallback(): NativeKVStorage {
  return {
    isSyncCapable: false,
    getItem: async (key: string) => {
      try {
        return await AsyncStorage.getItem(key);
      } catch {
        return null;
      }
    },
    setItem: async (key: string, value: string) => {
      await AsyncStorage.setItem(key, value);
    },
    removeItem: async (key: string) => {
      try {
        await AsyncStorage.removeItem(key);
      } catch {}
    },
    multiRemove: async (keys: string[]) => {
      try {
        if (keys.length > MULTI_REMOVE_YIELD_CHUNK) {
          for (let i = 0; i < keys.length; i += MULTI_REMOVE_YIELD_CHUNK) {
            const batch = keys.slice(i, i + MULTI_REMOVE_YIELD_CHUNK);
            if (typeof AsyncStorage.multiRemove === 'function') {
              await AsyncStorage.multiRemove(batch);
            } else {
              await Promise.all(batch.map((k) => AsyncStorage.removeItem(k)));
            }
            if (i + MULTI_REMOVE_YIELD_CHUNK < keys.length) {
              await yieldMultiRemove();
            }
          }
        } else if (typeof AsyncStorage.multiRemove === 'function') {
          await AsyncStorage.multiRemove(keys);
        } else {
          await Promise.all(keys.map((k) => AsyncStorage.removeItem(k)));
        }
      } catch {}
    },
    getItemSync: () => null,
    setItemSync: () => {},
    removeItemSync: () => {},
  };
}

export function createNativeKVStorage(id: string): NativeKVStorage {
  let backend: NativeKVStorage | null = null;

  const getBackend = (): NativeKVStorage => {
    if (backend) return backend;

    const MMKV = resolveMMKVConstructor();
    if (MMKV) {
      try {
        const mmkv = new MMKV({ id });
        if (typeof mmkv.getString === 'function' && typeof mmkv.set === 'function') {
          backend = {
            isSyncCapable: true,
            getItem: async (key: string) => mmkv.getString(key) ?? null,
            setItem: async (key: string, value: string) => {
              mmkv.set(key, value);
            },
            removeItem: async (key: string) => {
              mmkv.delete(key);
            },
            multiRemove: async (keys: string[]) => {
              for (let i = 0; i < keys.length; i += 1) {
                mmkv.delete(keys[i]);
                if (
                  keys.length > MULTI_REMOVE_YIELD_CHUNK &&
                  (i + 1) % MULTI_REMOVE_YIELD_CHUNK === 0 &&
                  i + 1 < keys.length
                ) {
                  await yieldMultiRemove();
                }
              }
            },
            getItemSync: (key: string) => mmkv.getString(key) ?? null,
            setItemSync: (key: string, value: string) => {
              mmkv.set(key, value);
            },
            removeItemSync: (key: string) => {
              mmkv.delete(key);
            },
            trim: async () => {
              mmkv.trim?.();
            },
          };
          return backend;
        }
      } catch (e) {
        console.warn(`[native-kv-storage] Failed to instantiate MMKV for id '${id}', using AsyncStorage fallback:`, e);
      }
    }

    backend = createAsyncStorageFallback();
    return backend;
  };

  return {
    get isSyncCapable(): boolean {
      return getBackend().isSyncCapable;
    },
    getItem: (key: string) => getBackend().getItem(key),
    setItem: (key: string, value: string) => getBackend().setItem(key, value),
    removeItem: (key: string) => getBackend().removeItem(key),
    multiRemove: (keys: string[]) => getBackend().multiRemove(keys),
    getItemSync: (key: string) => getBackend().getItemSync(key),
    setItemSync: (key: string, value: string) => getBackend().setItemSync(key, value),
    removeItemSync: (key: string) => getBackend().removeItemSync(key),
    trim: () => getBackend().trim?.() ?? Promise.resolve(),
  };
}

export const catalogKVStorage: NativeKVStorage = createNativeKVStorage('ventify-catalog');
export const cartKVStorage: NativeKVStorage = createNativeKVStorage('ventify-cart');
export const metaKVStorage: NativeKVStorage = createNativeKVStorage('ventify-meta');
