import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CatalogCacheStorage } from './product-catalog-cache';

export interface NativeKVStorage extends CatalogCacheStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  multiRemove(keys: string[]): Promise<void>;
  trim?: () => Promise<void>;
}

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
        if (typeof AsyncStorage.multiRemove === 'function') {
          await AsyncStorage.multiRemove(keys);
        } else {
          await Promise.all(keys.map((k) => AsyncStorage.removeItem(k)));
        }
      } catch {}
    },
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
            getItem: async (key: string) => {
              const val = mmkv.getString(key);
              return val !== undefined ? val : null;
            },
            setItem: async (key: string, value: string) => {
              mmkv.set(key, value);
            },
            removeItem: async (key: string) => {
              mmkv.delete(key);
            },
            multiRemove: async (keys: string[]) => {
              for (const k of keys) {
                mmkv.delete(k);
              }
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
    getItem: (key: string) => getBackend().getItem(key),
    setItem: (key: string, value: string) => getBackend().setItem(key, value),
    removeItem: (key: string) => getBackend().removeItem(key),
    multiRemove: (keys: string[]) => getBackend().multiRemove(keys),
    trim: () => getBackend().trim?.() ?? Promise.resolve(),
  };
}

export const catalogKVStorage: NativeKVStorage = createNativeKVStorage('ventify-catalog');
export const cartKVStorage: NativeKVStorage = createNativeKVStorage('ventify-cart');
