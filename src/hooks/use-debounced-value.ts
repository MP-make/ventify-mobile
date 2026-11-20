import { useEffect, useState } from 'react';

/** Keep text inputs responsive while delaying expensive derived work until typing pauses. */
export const useDebouncedValue = <T,>(value: T, delayMs = 150): T => {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    if (Object.is(value, debouncedValue)) return;
    if (value === '' || delayMs <= 0) {
      setDebouncedValue(value);
      return;
    }
    const timeout = setTimeout(() => setDebouncedValue(value), delayMs);
    return () => clearTimeout(timeout);
  }, [value, debouncedValue, delayMs]);

  return debouncedValue;
};
