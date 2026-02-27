import { useCallback, useEffect, useRef, useState } from 'react';
import { formatTimeAgo } from '../utils/time';
import './SearchPalette.css';

interface SearchResult {
  conversationId: string;
  messageIndex: number;
  role: string;
  snippet: string;
  workingDirectory: string;
  timestamp: Date;
}

interface SearchResultResponse {
  conversationId: string;
  messageIndex: number;
  role: string;
  snippet: string;
  workingDirectory: string;
  timestamp: string;
}

interface SearchApiResponse {
  results: SearchResultResponse[];
  query: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSelectConversation: (id: string) => void;
  /** When set, only search conversations whose workingDirectory starts with this path */
  filterDirectory?: string;
}

const MAX_RESULTS = 50;
const MIN_SEARCH_QUERY_LENGTH = 2;
const SEARCH_DEBOUNCE_MS = 150;

function highlightMatch(snippet: string, query: string): React.ReactNode[] {
  if (!query) return [snippet];

  const lowerSnippet = snippet.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  let searchFrom = 0;
  while (searchFrom < lowerSnippet.length) {
    const matchIndex = lowerSnippet.indexOf(lowerQuery, searchFrom);
    if (matchIndex === -1) break;

    if (matchIndex > lastIndex) {
      parts.push(snippet.substring(lastIndex, matchIndex));
    }
    parts.push(
      <mark key={matchIndex} className="search-highlight">
        {snippet.substring(matchIndex, matchIndex + query.length)}
      </mark>
    );
    lastIndex = matchIndex + query.length;
    searchFrom = lastIndex;
  }

  if (lastIndex < snippet.length) {
    parts.push(snippet.substring(lastIndex));
  }

  return parts;
}

export function SearchPalette({ isOpen, onClose, onSelectConversation, filterDirectory }: Props) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  // Debounce query by 150ms
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // Reset on open
  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setDebouncedQuery('');
    setResults([]);
    setSelectedIndex(0);
    setSearchError(null);
    setIsSearching(false);
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [isOpen]);

  useEffect(() => {
    const trimmed = debouncedQuery.trim();
    if (trimmed.length < MIN_SEARCH_QUERY_LENGTH) {
      setResults([]);
      setSearchError(null);
      setIsSearching(false);
      return;
    }

    const params = new URLSearchParams({
      q: trimmed,
      limit: String(MAX_RESULTS),
    });
    if (filterDirectory) {
      params.set('filterDirectory', filterDirectory);
    }

    const controller = new AbortController();
    setIsSearching(true);
    setSearchError(null);
    setResults([]);

    const runSearch = async () => {
      try {
        const response = await fetch(`/api/search?${params.toString()}`, {
          method: 'GET',
          signal: controller.signal,
        });

        if (!response.ok) {
          const data = (await response.json().catch(() => null)) as { error?: string } | null;
          const message = data?.error ?? `Search failed with status ${response.status}`;
          throw new Error(message);
        }

        const data = (await response.json().catch(() => null)) as SearchApiResponse | null;
        const apiResults = Array.isArray(data?.results) ? data.results : [];
        const normalizedResults = apiResults.map((result: SearchResultResponse) => ({
          ...result,
          timestamp: new Date(result.timestamp),
        }));
        setResults(normalizedResults);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        setSearchError(error instanceof Error ? error.message : 'Search failed');
        setResults([]);
      } finally {
        setIsSearching(false);
      }
    };

    runSearch();
    return () => {
      controller.abort();
    };
  }, [debouncedQuery, filterDirectory]);

  // Reset selection when results change
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on results length change
  useEffect(() => {
    setSelectedIndex(0);
  }, [results.length]);

  // Scroll selected item into view
  useEffect(() => {
    const container = resultsRef.current;
    if (!container) return;
    const selected = container.children[selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          if (!results.length) return;
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
          break;
        case 'ArrowUp':
          if (!results.length) return;
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          if (results[selectedIndex]) {
            onSelectConversation(results[selectedIndex].conversationId);
            onClose();
          }
          break;
        case 'Escape':
          onClose();
          break;
      }
    },
    [results, selectedIndex, onSelectConversation, onClose]
  );

  if (!isOpen) return null;

  const folderName = (dir: string) => dir.split('/').filter(Boolean).pop() ?? dir;

  return (
    <div className="search-palette-overlay" onClick={onClose}>
      <div className="search-palette" onClick={(e) => e.stopPropagation()}>
        <div className="search-palette-input-row">
          <svg
            role="img"
            aria-label="Search"
            className="search-palette-icon"
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
          >
            <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" />
            <line
              x1="11"
              y1="11"
              x2="14.5"
              y2="14.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="search-palette-input"
            placeholder={
              filterDirectory
                ? `Search in ${filterDirectory.split('/').filter(Boolean).pop()}...`
                : 'Search all conversations...'
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <kbd className="search-palette-shortcut">esc</kbd>
        </div>
        <div className="search-palette-results" ref={resultsRef}>
          {isSearching ? (
            <div className="search-palette-empty">Searching…</div>
          ) : searchError ? (
            <div className="search-palette-empty">{searchError}</div>
          ) : results.length > 0 ? (
            results.map((result, i) => (
              <div
                key={`${result.conversationId}-${result.messageIndex}`}
                className={`search-result-item ${i === selectedIndex ? 'selected' : ''}`}
                onClick={() => {
                  onSelectConversation(result.conversationId);
                  onClose();
                }}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                <div className="search-result-header">
                  <span className="search-result-folder">
                    {folderName(result.workingDirectory)}
                  </span>
                  <span className={`search-result-role search-result-role--${result.role}`}>
                    {result.role}
                  </span>
                  <span className="search-result-time">{formatTimeAgo(result.timestamp)}</span>
                </div>
                <div className="search-result-snippet">
                  {highlightMatch(result.snippet, debouncedQuery.trim())}
                </div>
              </div>
            ))
          ) : debouncedQuery.trim().length >= MIN_SEARCH_QUERY_LENGTH ? (
            <div className="search-palette-empty">No matches found</div>
          ) : (
            <div className="search-palette-empty">
              Type at least {MIN_SEARCH_QUERY_LENGTH} characters to search
            </div>
          )}
        </div>
        {results.length >= MAX_RESULTS && (
          <div className="search-palette-footer">
            Showing first {MAX_RESULTS} results — refine your query for more
          </div>
        )}
      </div>
    </div>
  );
}
