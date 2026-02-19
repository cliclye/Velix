/**
 * SafetyControls - Safety toggles and kill switch
 */

import React, { useState } from 'react';

interface SafetyControlsProps {
  safeMode: boolean;
  dryRun: boolean;
  onSafeModeChange: (enabled: boolean) => void;
  onDryRunChange: (enabled: boolean) => void;
  onKillSwitch: () => void;
  isRunning: boolean;
  theme: 'light' | 'dark';
}

export const SafetyControls: React.FC<SafetyControlsProps> = ({
  safeMode,
  dryRun,
  onSafeModeChange,
  onDryRunChange,
  onKillSwitch,
  isRunning,
  theme,
}) => {
  const [confirmKill, setConfirmKill] = useState(false);

  const handleKillSwitch = () => {
    if (confirmKill) {
      onKillSwitch();
      setConfirmKill(false);
    } else {
      setConfirmKill(true);
      // Reset after 5 seconds
      setTimeout(() => setConfirmKill(false), 5000);
    }
  };

  return (
    <div className={`safety-controls ${theme}`}>
      <div className="safety-toggles">
        <label className="toggle-item">
          <input
            type="checkbox"
            checked={safeMode}
            onChange={(e) => onSafeModeChange(e.target.checked)}
            disabled={isRunning}
          />
          <span className="toggle-label">
            <span className="toggle-icon">[S]</span>
            Safe Mode
          </span>
          <span className="toggle-description">
            Require approval for all actions
          </span>
        </label>

        <label className="toggle-item">
          <input
            type="checkbox"
            checked={dryRun}
            onChange={(e) => onDryRunChange(e.target.checked)}
            disabled={isRunning}
          />
          <span className="toggle-label">
            <span className="toggle-icon">[D]</span>
            Dry Run
          </span>
          <span className="toggle-description">
            Simulate without making changes
          </span>
        </label>
      </div>

      <div className="kill-switch-container">
        <button
          className={`kill-switch ${confirmKill ? 'confirm' : ''}`}
          onClick={handleKillSwitch}
          disabled={!isRunning}
        >
          {confirmKill ? '! Confirm Kill Switch' : 'X Kill Switch'}
        </button>
        {confirmKill && (
          <span className="kill-warning">
            Click again to terminate all agents
          </span>
        )}
      </div>

      <div className="safety-info">
        <div className="info-item">
          <span className="info-icon">[T]</span>
          <span>Max runtime: 10 min/agent</span>
        </div>
        <div className="info-item">
          <span className="info-icon">[R]</span>
          <span>Max retries: 3</span>
        </div>
        <div className="info-item">
          <span className="info-icon">[A]</span>
          <span>Max agents: 5</span>
        </div>
      </div>
    </div>
  );
};
