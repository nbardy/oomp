import { useCallback, useEffect, useRef, useState } from 'react';
import './PathAutocomplete.css';

interface PathEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

/**
 * PathAutocomplete - A directory path input with autocomplete suggestions.
 *
 * Features:
 * - Fetches directory listings from /api/paths endpoint
 * - Shows folder icons for directory suggestions
 * - Keyboard navigation (up/down arrows, enter to select, escape to close)
 * - Debounced API calls to avoid excessive requests
 * - Supports ~ expansion for home directory
 */
export function PathAutocomplete({
  value,
  onChange,
  placeholder = '/path/to/directory',
  className = '',
}: Props) {
  const [suggestions, setSuggestions] = useState<PathEntry[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch suggestions from the server
  const fetchSuggestions = useCallback(async (path: string) => {
    setIsLoading(true);
    try {
      const response = await fetch(`/api/paths?path=${encodeURIComponent(path)}`);
      if (response.ok) {
        const data = (await response.json()) as PathEntry[];
        setSuggestions(data);
        setSelectedIndex(0);
      } else {
        setSuggestions([]);
      }
    } catch {
      setSuggestions([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Debounced fetch when value changes
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      if (value) {
        fetchSuggestions(value);
      } else {
        // Fetch home directory contents when empty
        fetchSuggestions('');
      }
    }, 150);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [value, fetchSuggestions]);

  // Close suggestions when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value);
    setShowSuggestions(true);
  };

  const handleInputFocus = () => {
    setShowSuggestions(true);
    // Fetch suggestions on focus if we don't have any
    if (suggestions.length === 0) {
      fetchSuggestions(value);
    }
  };

  const handleSelectSuggestion = (suggestion: PathEntry) => {
    // Append a trailing slash to indicate it's a directory
    const newValue = suggestion.path.endsWith('/') ? suggestion.path : `${suggestion.path}/`;
    onChange(newValue);
    setShowSuggestions(false);
    inputRef.current?.focus();
    // Immediately fetch contents of the selected directory
    fetchSuggestions(newValue);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showSuggestions || suggestions.length === 0) {
      // Still allow escape to close empty dropdown
      if (e.key === 'Escape') {
        setShowSuggestions(false);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, suggestions.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (suggestions[selectedIndex]) {
          handleSelectSuggestion(suggestions[selectedIndex]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        setShowSuggestions(false);
        break;
      case 'Tab':
        // Tab completes the current selection
        if (suggestions[selectedIndex]) {
          e.preventDefault();
          handleSelectSuggestion(suggestions[selectedIndex]);
        }
        break;
    }
  };

  // Scroll selected item into view
  useEffect(() => {
    if (showSuggestions && suggestions.length > 0) {
      const selectedElement = document.querySelector('.path-suggestion-item.selected');
      selectedElement?.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex, showSuggestions, suggestions.length]);

  return (
    <div className={`path-autocomplete ${className}`} ref={containerRef}>
      <div className="path-input-wrapper">
        <input
          ref={inputRef}
          type="text"
          className="path-input"
          value={value}
          onChange={handleInputChange}
          onFocus={handleInputFocus}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
        />
        {isLoading && <span className="path-loading-indicator" />}
      </div>

      {showSuggestions && suggestions.length > 0 && (
        <div className="path-suggestions">
          {suggestions.map((suggestion, index) => (
            <div
              key={suggestion.path}
              className={`path-suggestion-item ${index === selectedIndex ? 'selected' : ''}`}
              onClick={() => handleSelectSuggestion(suggestion)}
              onMouseEnter={() => setSelectedIndex(index)}
            >
              <span className="path-folder-icon">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              </span>
              <span className="path-suggestion-name">{suggestion.name}</span>
              <span className="path-suggestion-path">{suggestion.path}</span>
            </div>
          ))}
        </div>
      )}

      {showSuggestions && suggestions.length === 0 && !isLoading && value && (
        <div className="path-suggestions">
          <div className="path-no-results">No matching directories</div>
        </div>
      )}
    </div>
  );
}
