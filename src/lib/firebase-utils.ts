/**
 * Firebase Firestore Utilities
 * Provides deep recursive sanitization and payload cleaning to ensure
 * zero `undefined` values reach Firestore write/transaction operations.
 */

/**
 * Recursively cleans an object or array to ensure no `undefined` values exist.
 * - Primitive `undefined` inside arrays is filtered.
 * - Undefined properties in objects are omitted.
 * - Copy-on-write: preserves original references when nothing changes.
 * - Preserves Firestore special types (FieldValue, Timestamp, Date).
 */
export function cleanFirestoreData<T>(value: T): T {
  if (value === undefined || value === null) {
    return null as any;
  }
  if (typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    let nextArr: any[] | null = null;
    for (let i = 0; i < value.length; i += 1) {
      const item = value[i];
      if (item === undefined) {
        if (!nextArr) nextArr = value.slice(0, i);
        continue;
      }
      const cleanedItem = cleanFirestoreData(item);
      if (cleanedItem !== item && !nextArr) {
        nextArr = value.slice(0, i);
      }
      if (nextArr) {
        nextArr.push(cleanedItem);
      }
    }
    return (nextArr ?? value) as any;
  }
  if (value instanceof Date) {
    return value;
  }
  const obj = value as Record<string, any>;
  if (
    '_methodName' in obj ||
    ('seconds' in obj && 'nanoseconds' in obj) ||
    ('_delegate' in obj)
  ) {
    return value;
  }

  let nextObj: Record<string, any> | null = null;
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const val = obj[key];
    if (val === undefined) {
      if (!nextObj) {
        nextObj = {};
        for (let j = 0; j < i; j += 1) {
          nextObj[keys[j]] = obj[keys[j]];
        }
      }
      continue;
    }
    const cleanedVal = cleanFirestoreData(val);
    if (cleanedVal !== val && !nextObj) {
      nextObj = {};
      for (let j = 0; j < i; j += 1) {
        nextObj[keys[j]] = obj[keys[j]];
      }
    }
    if (nextObj) {
      nextObj[key] = cleanedVal;
    }
  }
  return (nextObj ?? value) as T;
}
