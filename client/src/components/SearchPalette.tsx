import { useAtomValue } from 'jotai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { allConversationsAtom } from '../atoms/conversations';
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

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSelectConversation: (id: string) => void;
  /** When set, only search conversations whose workingDirectory starts with this path */
  filterDirectory?: string;
}

const MAX_RESULTS = 50;
const SNIPPET_RADIUS = 60; // chars before/after match to show

function buildSnippet(content: string, query: string): string {
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matchIndex = lowerContent.indexOf(lowerQuery);
  if (matchIndex === -1) return content.substring(0, 120);

  const start = Math.max(0, matchIndex - SNIPPET_RADIUS);
  const end = Math.min(content.length, matchIndex + query.length + SNIPPET_RADIUS);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < content.length ? '...' : '';
  return prefix + content.substring(start, end) + suffix;
}

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
  // allConversationsAtom is stable during streaming — no snapshot hack needed
  const allConversations = useAtomValue(allConversationsAtom);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  // Debounce query by 150ms
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 150);
    return () => clearTimeout(timer);
  }, [query]);

  // Reset on open
  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setDebouncedQuery('');
    setSelectedIndex(0);
    const timer = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, [isOpen]);

  const results: SearchResult[] = useMemo(() => {
    const trimmed = debouncedQuery.trim();
    if (trimmed.length < 2) return [];

    const lowerQuery = trimmed.toLowerCase();
    const matches: SearchResult[] = [];

    for (const conv of allConversations) {
      if (filterDirectory && !conv.workingDirectory.startsWith(filterDirectory)) continue;
      for (let i = 0; i < conv.messages.length; i++) {
        const msg = conv.messages[i];
        if (msg.content.toLowerCase().includes(lowerQuery)) {
          matches.push({
            conversationId: conv.id,
            messageIndex: i,
            role: msg.role,
            snippet: buildSnippet(msg.content, trimmed),
            workingDirectory: conv.workingDirectory,
            timestamp: new Date(msg.timestamp),
          });
          if (matches.length >= MAX_RESULTS) return matches;
        }
      }
    }

    return matches;
  }, [allConversations, debouncedQuery, filterDirectory]);

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
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
          break;
        case 'ArrowUp':
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
          {results.length > 0 ? (
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
          ) : debouncedQuery.trim().length >= 2 ? (
            <div className="search-palette-empty">No matches found</div>
          ) : (
            <div className="search-palette-empty">Type at least 2 characters to search</div>
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
