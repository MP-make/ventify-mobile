import { useEffect, useRef, useState } from 'react';

/** Keep text inputs responsive while delaying expensive derived work until typing pauses. */
export const useDebouncedValue = <T,>(value: T, delayMs = 150): T => {
  const [debouncedValue, setDebouncedValue] = useState(value);
  const debouncedRef = useRef(debouncedValue);
  debouncedRef.current = debouncedValue;

  useEffect(() => {
    if (Object.is(value, debouncedRef.current)) return;
    if (value === '' || delayMs <= 0) {
      debouncedRef.current = value;
      setDebouncedValue(value);
      return;
    }
    const timeout = setTimeout(() => {
      debouncedRef.current = value;
      setDebouncedValue(value);
    }, delayMs);
    return () => clearTimeout(timeout);
  }, [value, delayMs]);

  return debouncedValue;
};
