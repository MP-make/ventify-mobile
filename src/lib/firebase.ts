/**
 * Firebase Client Initialization for React Native (Expo SDK 52)
 * Optimized for mobile network resilience and native persistence
 */

import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import {
  initializeFirestore,
  getFirestore,
  Firestore,
  memoryLocalCache,
} from 'firebase/firestore';
import {
  initializeAuth,
  getAuth,
  Auth,
  type Persistence,
} from 'firebase/auth';
import { getStorage, FirebaseStorage } from 'firebase/storage';

// 1. Resolve environment variables (supporting EXPO_PUBLIC_* and NEXT_PUBLIC_*)
const firebaseConfig = {
  apiKey:
    process.env.EXPO_PUBLIC_FIREBASE_API_KEY ||
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY ||
    'AIzaSyC9GjBZdKaG_wRSjuhAQgsZW_IYhwAaEgc',
  authDomain:
    process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN ||
    process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ||
    'ventify-xead3.firebaseapp.com',
  projectId:
    process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
    'ventify-xead3',
  storageBucket:
    process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET ||
    process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ||
    'ventify-xead3.firebasestorage.app',
  messagingSenderId:
    process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ||
    process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ||
    '954282952004',
  appId:
    process.env.EXPO_PUBLIC_FIREBASE_APP_ID ||
    process.env.NEXT_PUBLIC_FIREBASE_APP_ID ||
    '1:954282952004:web:f29d5bccbd879933900311',
};

export const APP_URL: string =
  process.env.EXPO_PUBLIC_APP_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  'https://ventify.com.pe';

type PersistenceFactory = (storage: unknown) => Persistence;

function resolveReactNativePersistence(): PersistenceFactory | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const authModule = require('firebase/auth');
    const candidate =
      authModule?.getReactNativePersistence ??
      authModule?.default?.getReactNativePersistence;
    if (typeof candidate === 'function') {
      return candidate as PersistenceFactory;
    }
  } catch {
    // Fallback to @firebase/auth directly below
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rnAuthModule = require('@firebase/auth');
    const candidate =
      rnAuthModule?.getReactNativePersistence ??
      rnAuthModule?.default?.getReactNativePersistence;
    if (typeof candidate === 'function') {
      return candidate as PersistenceFactory;
    }
  } catch {
    // Expected in pure Node/Vitest or browser environments
  }

  return null;
}

function resolveAsyncStorage(): unknown | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const storageModule = require('@react-native-async-storage/async-storage');
    const candidate = storageModule?.default ?? storageModule;
    if (
      candidate &&
      typeof candidate.getItem === 'function' &&
      typeof candidate.setItem === 'function'
    ) {
      return candidate;
    }
  } catch {
    // Expected in pure Node/Vitest when RN native modules are unavailable
  }
  return null;
}

// 2. Initialize or get Firebase App
const app: FirebaseApp = !getApps().length
  ? initializeApp(firebaseConfig)
  : getApp();

// 3. Initialize Firebase Auth with React Native AsyncStorage Persistence
let authInstance: Auth;
try {
  const getPersistence = resolveReactNativePersistence();
  const asyncStorage = getPersistence ? resolveAsyncStorage() : null;

  if (getPersistence && asyncStorage) {
    authInstance = initializeAuth(app, {
      persistence: getPersistence(asyncStorage),
    });
  } else {
    authInstance = getAuth(app);
  }
} catch {
  // Safe fallback if already initialized or in web/test environment
  authInstance = getAuth(app);
}

export const auth: Auth = authInstance;

// 4. Initialize Firestore with Auto-Detect Long Polling for React Native Android/iOS
let dbInstance: Firestore;
try {
  dbInstance = initializeFirestore(app, {
    experimentalAutoDetectLongPolling: true,
    localCache: memoryLocalCache(),
  });
} catch {
  // Fallback if firestore has already been initialized with a previous configuration
  dbInstance = getFirestore(app);
}

export const db: Firestore = dbInstance;

// 5. Initialize Firebase Storage for catalog & asset uploads
export const storage: FirebaseStorage = getStorage(app);

export { app };
