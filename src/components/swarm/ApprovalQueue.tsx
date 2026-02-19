/**
 * ApprovalQueue - Display and manage pending approvals
 */

import React from 'react';
import { PendingApproval } from '../../services/swarm/types';

interface ApprovalQueueProps {
  approvals: PendingApproval[];
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
  theme: 'light' | 'dark';
}

export const ApprovalQueue: React.FC<ApprovalQueueProps> = ({
  approvals,
  onApprove,
  onDeny,
  theme,
}) => {
  const formatTime = (date: Date) => {
    return date.toLocaleTimeString();
  };

  const getCategoryIcon = (patternId: string) => {
    if (patternId.includes('file') || patternId.includes('overwrite')) {
      return '[F]';
    }
    if (patternId.includes('install') || patternId.includes('npm')) {
      return '[P]';
    }
    if (patternId.includes('test')) {
      return '[T]';
    }
    if (patternId.includes('git')) {
      return '[G]';
    }
    return '[?]';
  };

  if (approvals.length === 0) {
    return (
      <div className={`approval-queue empty ${theme}`}>
        <p>No pending approvals</p>
      </div>
    );
  }

  return (
    <div className={`approval-queue ${theme}`}>
      {approvals.map((approval) => (
        <div key={approval.id} className="approval-item">
          <div className="approval-header">
            <span className="approval-icon">
              {getCategoryIcon(approval.patternMatch.patternId)}
            </span>
            <span className="approval-pattern">
              {approval.patternMatch.patternId.replace(/_/g, ' ')}
            </span>
            <span className="approval-time">
              {formatTime(approval.timestamp)}
            </span>
          </div>

          <div className="approval-content">
            <div className="matched-text">
              <strong>Detected:</strong> {approval.patternMatch.matchedText}
            </div>
            <div className="context-preview">
              <pre>{approval.context.slice(0, 200)}...</pre>
            </div>
          </div>

          <div className="approval-confidence">
            <span className="label">Confidence:</span>
            <span className={`value ${approval.patternMatch.confidence >= 0.7 ? 'high' : 'low'}`}>
              {(approval.patternMatch.confidence * 100).toFixed(0)}%
            </span>
          </div>

          <div className="approval-actions">
            <button
              className="approve-btn"
              onClick={() => onApprove(approval.id)}
            >
              Approve
            </button>
            <button
              className="deny-btn"
              onClick={() => onDeny(approval.id)}
            >
              Deny
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};
