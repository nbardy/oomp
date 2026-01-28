/**
 * useFolderFilter - Hook for managing folder filter state
 *
 * Design:
 * - Empty selection = all items pass filter
 * - Non-empty selection = only items in selected folders pass
 * - toggle() adds/removes folder from selection
 * - filter() returns filtered items
 */

import { useCallback, useMemo, useState } from 'react';

interface UseFolderFilterOptions<T> {
  items: T[];
  getFolder: (item: T) => string;
}

interface UseFolderFilterResult<T> {
  /** All unique folders extracted from items */
  folders: string[];
  /** Currently selected folders (empty = all) */
  selected: Set<string>;
  /** Toggle a folder in/out of selection */
  toggle: (folder: string) => void;
  /** Items filtered by selection */
  filtered: T[];
}

export function useFolderFilter<T>({ items, getFolder }: UseFolderFilterOptions<T>): UseFolderFilterResult<T> {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Extract unique folders, sorted alphabetically
  const folders = useMemo(() => {
    const uniqueFolders = new Set<string>();
    items.forEach((item) => {
      uniqueFolders.add(getFolder(item));
    });
    return Array.from(uniqueFolders).sort();
  }, [items, getFolder]);

  // Toggle a folder in/out of selection
  const toggle = useCallback((folder: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) {
        next.delete(folder);
      } else {
        next.add(folder);
      }
      return next;
    });
  }, []);

  // Filter items by selection (empty = all pass)
  const filtered = useMemo(() => {
    if (selected.size === 0) {
      return items;
    }
    return items.filter((item) => selected.has(getFolder(item)));
  }, [items, selected, getFolder]);

  return { folders, selected, toggle, filtered };
}
