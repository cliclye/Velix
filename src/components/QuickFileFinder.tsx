import React, { useState, useEffect, useRef, useMemo } from 'react';
import '../styles/QuickFileFinder.css';

interface QuickFileFinderProps {
  isOpen: boolean;
  onClose: () => void;
  files: string[];
  onFileSelect: (filePath: string) => void;
}

const QuickFileFinder: React.FC<QuickFileFinderProps> = ({
  isOpen,
  onClose,
  files,
  onFileSelect,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fuzzy search implementation
  const fuzzyMatch = (str: string, pattern: string): boolean => {
    const lowerStr = str.toLowerCase();
    const lowerPattern = pattern.toLowerCase();

    let patternIdx = 0;
    for (let strIdx = 0; strIdx < lowerStr.length; strIdx++) {
      if (lowerStr[strIdx] === lowerPattern[patternIdx]) {
        patternIdx++;
      }
      if (patternIdx === lowerPattern.length) return true;
    }
    return patternIdx === lowerPattern.length;
  };

  // Score for ranking results
  const scoreMatch = (str: string, pattern: string): number => {
    if (!pattern) return 0;
    const lowerStr = str.toLowerCase();
    const lowerPattern = pattern.toLowerCase();

    // Exact match gets highest score
    if (lowerStr.includes(lowerPattern)) {
      return 100 - lowerStr.indexOf(lowerPattern);
    }

    // Fuzzy match gets lower score
    if (fuzzyMatch(str, pattern)) {
      return 50;
    }

    return 0;
  };

  const filteredFiles = useMemo(() => files
    .map(file => ({
      path: file,
      score: scoreMatch(file, searchTerm)
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(item => item.path)
    .slice(0, 50), [files, searchTerm]); // Limit to 50 results

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
      setSearchTerm('');
      setSelectedIndex(0);
    }
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [searchTerm]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev =>
        filteredFiles.length > 0 ? Math.min(prev + 1, filteredFiles.length - 1) : 0
      );
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredFiles[selectedIndex]) {
        onFileSelect(filteredFiles[selectedIndex]);
        onClose();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const highlightMatch = (text: string, pattern: string) => {
    if (!pattern) return <span>{text}</span>;

    const lowerText = text.toLowerCase();
    const lowerPattern = pattern.toLowerCase();
    const parts: React.ReactElement[] = [];
    let lastIndex = 0;
    let patternIdx = 0;

    for (let i = 0; i < text.length; i++) {
      if (lowerText[i] === lowerPattern[patternIdx]) {
        if (lastIndex < i) {
          parts.push(<span key={`text-${lastIndex}`}>{text.substring(lastIndex, i)}</span>);
        }
        parts.push(<span key={`match-${i}`} className="highlight">{text[i]}</span>);
        lastIndex = i + 1;
        patternIdx++;
      }
    }

    if (lastIndex < text.length) {
      parts.push(<span key={`text-${lastIndex}`}>{text.substring(lastIndex)}</span>);
    }

    return <>{parts}</>;
  };

  if (!isOpen) return null;

  return (
    <div className="quick-finder-overlay" onClick={onClose}>
      <div className="quick-finder-modal" onClick={(e) => e.stopPropagation()}>
        <div className="quick-finder-header">
          <input
            ref={inputRef}
            type="text"
            className="quick-finder-input"
            placeholder="Search files... (fuzzy search enabled)"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="quick-finder-results">
          {filteredFiles.length === 0 && searchTerm && (
            <div className="no-results">No files found</div>
          )}
          {filteredFiles.length === 0 && !searchTerm && (
            <div className="no-results">Type to search files...</div>
          )}
          {filteredFiles.map((file, index) => (
            <div
              key={file}
              className={`quick-finder-item ${index === selectedIndex ? 'selected' : ''}`}
              onClick={() => {
                onFileSelect(file);
                onClose();
              }}
              onMouseEnter={() => setSelectedIndex(index)}
            >
              <div className="file-path">
                {highlightMatch(file, searchTerm)}
              </div>
            </div>
          ))}
        </div>
        <div className="quick-finder-footer">
          <span>Up/Down Navigate</span>
          <span>Enter Open</span>
          <span>Esc Close</span>
        </div>
      </div>
    </div>
  );
};

export default QuickFileFinder;
