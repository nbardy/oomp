/**
 * FolderFilter - Generic folder/tag filter component
 *
 * Design: Controlled component with no internal state.
 * - Empty selection = all items shown
 * - Click toggles folder on/off
 * - Multiple selection supported
 */

import './FolderFilter.css';

interface FolderFilterProps {
  folders: string[];
  selected: Set<string>;
  onToggle: (folder: string) => void;
  /** Optional: format folder for display (e.g., shorten paths) */
  formatFolder?: (folder: string) => string;
}

export function FolderFilter({ folders, selected, onToggle, formatFolder }: FolderFilterProps) {
  if (folders.length === 0) {
    return null;
  }

  const format = formatFolder ?? ((f) => f);
  const isAllSelected = selected.size === 0;

  return (
    <div className="folder-filter">
      <div className="folder-filter-label">Folders</div>
      <div className="folder-filter-chips">
        {folders.map((folder) => {
          const isSelected = selected.has(folder);
          const isActive = isAllSelected || isSelected;

          return (
            <button
              key={folder}
              type="button"
              className={`folder-chip ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''}`}
              onClick={() => onToggle(folder)}
              title={folder}
            >
              {format(folder)}
            </button>
          );
        })}
      </div>
      {selected.size > 0 && (
        <button
          type="button"
          className="folder-filter-clear"
          onClick={() => {
            // Clear all by toggling each selected
            selected.forEach((f) => onToggle(f));
          }}
        >
          Clear
        </button>
      )}
    </div>
  );
}
