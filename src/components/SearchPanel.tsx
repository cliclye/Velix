import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import '../styles/SearchPanel.css';

interface SearchMatch {
  file: string;
  line: number;
  column: number;
  text: string;
}

interface SearchPanelProps {
  currentDir: string;
  onResultClick: (file: string, line: number) => void;
}

export const SearchPanel: React.FC<SearchPanelProps> = ({ currentDir, onResultClick }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [results, setResults] = useState<SearchMatch[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchTime, setSearchTime] = useState<number | null>(null);

  const handleSearch = async () => {
    if (!searchTerm.trim() || !currentDir) return;

    setIsSearching(true);
    const startTime = Date.now();

    try {
      const matches = await invoke<SearchMatch[]>('search_in_files', {
        directory: currentDir,
        pattern: searchTerm,
        caseSensitive,
        maxResults: 500,
      });

      setResults(matches);
      setSearchTime(Date.now() - startTime);
    } catch (err) {
      console.error('Search failed:', err);
      setResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  const groupedResults = results.reduce((acc, match) => {
    if (!acc[match.file]) {
      acc[match.file] = [];
    }
    acc[match.file].push(match);
    return acc;
  }, {} as Record<string, SearchMatch[]>);

  return (
    <div className="search-panel">
      <div className="search-header">
        <h3>Search in Files</h3>
      </div>

      <div className="search-controls">
        <div className="search-input-wrapper">
          <input
            type="text"
            className="search-input"
            placeholder="Search pattern..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!currentDir}
          />
          <button
            className="search-btn"
            onClick={handleSearch}
            disabled={!searchTerm.trim() || isSearching || !currentDir}
          >
            {isSearching ? 'Searching...' : 'Search'}
          </button>
        </div>

        <label className="search-option">
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(e) => setCaseSensitive(e.target.checked)}
          />
          <span>Case sensitive</span>
        </label>
      </div>

      {!currentDir && (
        <div className="search-empty">
          <p>No project open</p>
        </div>
      )}

      {results.length > 0 && (
        <div className="search-summary">
          Found {results.length} match{results.length !== 1 ? 'es' : ''} in {Object.keys(groupedResults).length} file{Object.keys(groupedResults).length !== 1 ? 's' : ''}
          {searchTime !== null && ` (${searchTime}ms)`}
        </div>
      )}

      <div className="search-results">
        {results.length === 0 && searchTerm && !isSearching && currentDir && (
          <div className="no-results">No matches found</div>
        )}

        {Object.entries(groupedResults).map(([file, matches]) => (
          <div key={file} className="search-file-group">
            <div className="search-file-header">
              <span className="file-icon">F</span>
              <span className="file-name">{file}</span>
              <span className="match-count">{matches.length}</span>
            </div>
            <div className="search-file-matches">
              {matches.map((match, idx) => (
                <div
                  key={`${file}-${match.line}-${idx}`}
                  className="search-match"
                  onClick={() => onResultClick(file, match.line)}
                >
                  <span className="match-line-num">{match.line}:</span>
                  <span className="match-text">{match.text.trim()}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
