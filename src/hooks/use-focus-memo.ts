import { useRef } from 'react';

function areDepsEqual(
  prev: readonly unknown[] | null,
  next: readonly unknown[]
): boolean {
  if (!prev || prev.length !== next.length) return false;
  for (let i = 0; i < next.length; i += 1) {
    if (!Object.is(prev[i], next[i])) return false;
  }
  return true;
}

/**
 * Memoizes a derived value only while the screen is focused, and avoids recomputing
 * on tab focus when none of the dependency references changed since the last focused pass.
 */
export function useFocusMemo<T>(
  factory: () => T,
  deps: readonly unknown[],
  isFocused: boolean,
  initialValue: T
): T {
  const hasComputedRef = useRef(false);
  const valueRef = useRef<T>(initialValue);
  const lastDepsRef = useRef<readonly unknown[] | null>(null);

  if (!isFocused) {
    return hasComputedRef.current ? valueRef.current : initialValue;
  }

  if (hasComputedRef.current && areDepsEqual(lastDepsRef.current, deps)) {
    return valueRef.current;
  }

  const next = factory();
  valueRef.current = next;
  lastDepsRef.current = deps.slice();
  hasComputedRef.current = true;
  return next;
}
