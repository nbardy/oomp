/**
 * useLocalStorage - useState backed by localStorage for persistence.
 *
 * Supports primitives, objects, arrays, and Set<string>.
 * Sets are stored as JSON arrays and rehydrated on load.
 */

import { useState, useCallback } from 'react';

type Serializable = string | number | boolean | null | Serializable[] | { [key: string]: Serializable };

function load<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;

  const parsed = JSON.parse(raw);

  // Rehydrate Set<string> from array
  if (fallback instanceof Set) {
    return new Set(parsed) as T;
  }

  return parsed as T;
}

function save<T>(key: string, value: T): void {
  // Serialize Set as array
  if (value instanceof Set) {
    localStorage.setItem(key, JSON.stringify(Array.from(value)));
    return;
  }

  localStorage.setItem(key, JSON.stringify(value as Serializable));
}

export function useLocalStorage<T>(key: string, fallback: T): [T, (value: T | ((prev: T) => T)) => void] {
  const [state, setStateRaw] = useState<T>(() => load(key, fallback));

  const setState = useCallback(
    (value: T | ((prev: T) => T)) => {
      setStateRaw((prev) => {
        const next = value instanceof Function ? value(prev) : value;
        save(key, next);
        return next;
      });
    },
    [key],
  );

  return [state, setState];
}
