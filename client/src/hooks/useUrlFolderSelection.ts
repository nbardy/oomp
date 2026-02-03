/**
 * useUrlFolderSelection - URL-backed folder selection state
 *
 * Reads/writes `folders` query params via react-router useSearchParams.
 * - `/?folders=%2Fpath%2Fone&folders=%2Fpath%2Ftwo` = two folders selected
 * - `/` (no param) = no folders selected (show all)
 * - Setter uses `replace: true` so filter toggles don't create history entries.
 *   Chat→Gallery navigation uses Link (push), so back-button returns to chat.
 */

import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

type SetSelected = (value: Set<string> | ((prev: Set<string>) => Set<string>)) => void;

export function useUrlFolderSelection(): [Set<string>, SetSelected] {
  const [searchParams, setSearchParams] = useSearchParams();

  const selected = useMemo(
    () => new Set(searchParams.getAll('folders')),
    [searchParams],
  );

  const setSelected: SetSelected = useCallback(
    (value) => {
      setSearchParams((prev) => {
        const currentFolders = new Set(prev.getAll('folders'));
        const next = value instanceof Function ? value(currentFolders) : value;

        // Preserve non-folder params
        const updated = new URLSearchParams();
        for (const [key, val] of prev.entries()) {
          if (key !== 'folders') {
            updated.append(key, val);
          }
        }

        // Add folder params
        for (const folder of next) {
          updated.append('folders', folder);
        }

        return updated;
      }, { replace: true });
    },
    [setSearchParams],
  );

  return [selected, setSelected];
}
