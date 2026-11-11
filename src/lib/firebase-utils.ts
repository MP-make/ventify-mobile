/**
 * Firebase Firestore Utilities
 * Provides deep recursive sanitization and payload cleaning to ensure
 * zero `undefined` values reach Firestore write/transaction operations.
 */

/**
 * Recursively cleans an object or array to ensure no `undefined` values exist.
 * - Primitive `undefined` inside arrays is converted to `null` or filtered.
 * - Undefined properties in objects are omitted.
 * - Preserves Firestore special types (FieldValue, Timestamp, Date).
 */
export function cleanFirestoreData<T>(value: T): T {
  if (value === undefined) {
    return null as any;
  }
  if (value === null) {
    return null as any;
  }
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== undefined)
      .map((item) => cleanFirestoreData(item)) as any;
  }
  if (typeof value === 'object') {
    // Preserve Date
    if (value instanceof Date) {
      return value;
    }
    // Preserve Firestore FieldValues (serverTimestamp, increment, delete, arrayUnion, etc.)
    // or Timestamps (seconds + nanoseconds)
    const obj = value as Record<string, any>;
    if (
      '_methodName' in obj ||
      ('seconds' in obj && 'nanoseconds' in obj) ||
      ('_delegate' in obj)
    ) {
      return value;
    }

    const cleaned: Record<string, any> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (val !== undefined) {
        cleaned[key] = cleanFirestoreData(val);
      }
    }
    return cleaned as T;
  }
  return value;
}
