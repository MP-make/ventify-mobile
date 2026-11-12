import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CatalogCacheStorage } from './product-catalog-cache';

export interface NativeKVStorage extends CatalogCacheStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  multiRemove(keys: string[]): Promise<void>;
}

type MMKVInstance = {
  getString: (key: string) => string | undefined;
  set: (key: string, value: string | boolean | number) => void;
  delete: (key: string) => void;
  clearAll?: () => void;
};

type MMKVConstructor = new (options?: { id: string }) => MMKVInstance;

let MMKVClass: MMKVConstructor | null = null;
let mmkvAvailable: boolean | null = null;

function getMMKVClass(): MMKVConstructor | null {
  if (mmkvAvailable !== null) return MMKVClass;
  try {
    // Dynamic require so bundlers or Node/Vitest don't fail at module load
    const mmkvModule = require('react-native-mmkv');
    const Candidate: MMKVConstructor = mmkvModule.MMKV || mmkvModule.default?.MMKV;
    if (typeof Candidate === 'function') {
      // Test instantiate to ensure JSI is actually present in runtime
      const testInstance = new Candidate({ id: '__ventify_probe__' });
      if (typeof testInstance.getString === 'function' && typeof testInstance.set === 'function') {
        MMKVClass = Candidate;
        mmkvAvailable = true;
        try {
          testInstance.delete('__probe__');
        } catch {}
        return MMKVClass;
      }
    }
  } catch {
    // JSI not available (Node/Vitest, Web, or environment without native binary)
  }
  MMKVClass = null;
  mmkvAvailable = false;
  return null;
}

export function createNativeKVStorage(id: string): NativeKVStorage {
  const MMKV = getMMKVClass();
  if (MMKV) {
    try {
      const mmkv = new MMKV({ id });
      return {
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
      };
    } catch (e) {
      console.warn(`[native-kv-storage] Failed to instantiate MMKV for id '${id}', using AsyncStorage fallback:`, e);
    }
  }

  // Fallback a AsyncStorage para Node/Vitest, Web o Expo Go
  return {
    getItem: async (key: string) => {
      try {
        return await AsyncStorage.getItem(key);
      } catch {
        return null;
      }
    },
    setItem: async (key: string, value: string) => {
      try {
        await AsyncStorage.setItem(key, value);
      } catch (e) {
        console.warn(`[native-kv-storage] AsyncStorage setItem error for key '${key}':`, e);
      }
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

export const catalogKVStorage: NativeKVStorage = createNativeKVStorage('ventify-catalog');
export const cartKVStorage: NativeKVStorage = createNativeKVStorage('ventify-cart');
