import { useEffect, useState } from 'react';

/** Keep text inputs responsive while delaying expensive derived work until typing pauses. */
export const useDebouncedValue = <T,>(value: T, delayMs = 150): T => {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedValue(value), delayMs);
    return () => clearTimeout(timeout);
  }, [value, delayMs]);

  return debouncedValue;
};
