/**
 * AgentTerminal - Visual terminal display for swarm agents
 */

import React, { useState, useEffect, useRef } from 'react';
import { Agent } from '../../services/swarm/types';
import './AgentTerminal.css';

interface AgentTerminalProps {
  agent: Agent;
  theme: 'light' | 'dark';
}

export const AgentTerminal: React.FC<AgentTerminalProps> = ({ agent, theme }) => {
  // Defensive check for agent validity
  if (!agent || !agent.id || !agent.role) {
    return (
      <div className={`agent-terminal ${theme}`}>
        <div className="terminal-header">
          <div className="terminal-title">
            <span className="agent-role">Initializing...</span>
            <span className="agent-id">WAITING</span>
          </div>
          <div className="terminal-status">
            <div className="status-dot" style={{ backgroundColor: '#6B7280' }} />
            <span className="status-text">INITIALIZING</span>
          </div>
        </div>
        <div className="terminal-window">
          <div className="terminal-line">
            <span className="prompt">$</span>
            <span>Agent data loading...</span>
          </div>
        </div>
      </div>
    );
  }

  const [displayedOutput, setDisplayedOutput] = useState<string[]>([]);
  const [currentLine, setCurrentLine] = useState('');

  const terminalRef = useRef<HTMLDivElement>(null);
  const [cursorVisible, setCursorVisible] = useState(true);

  // Simulate typing effect
  useEffect(() => {
    if (agent.outputBuffer.length > displayedOutput.length) {
      const nextLine = agent.outputBuffer[displayedOutput.length];
      let charIndex = 0;
      
      const typeInterval = setInterval(() => {
        if (charIndex < nextLine.length) {
          setCurrentLine(nextLine.slice(0, charIndex + 1));
          charIndex++;
        } else {
          setCurrentLine('');
          setDisplayedOutput(prev => [...prev, nextLine]);
          clearInterval(typeInterval);
        }
      }, 30); // 30ms per character = typing speed

      return () => clearInterval(typeInterval);
    }
  }, [agent.outputBuffer, displayedOutput]);

  // Auto-scroll to bottom
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [displayedOutput, currentLine]);

  // Blinking cursor effect
  useEffect(() => {
    const interval = setInterval(() => {
      setCursorVisible(prev => !prev);
    }, 500);

    return () => clearInterval(interval);
  }, []);

  const getStatusColor = () => {
    switch (agent.status) {
      case 'running':
        return '#10B981'; // Green
      case 'waiting_for_input':
      case 'waiting_for_approval':
        return '#F59E0B'; // Orange
      case 'completed':
        return '#3B82F6'; // Blue
      case 'failed':
      case 'terminated':
        return '#EF4444'; // Red
      default:
        return '#6B7280'; // Gray
    }
  };

  const getStatusText = () => {
    switch (agent.status) {
      case 'running':
        return 'EXECUTING';
      case 'waiting_for_input':
        return 'WAITING';
      case 'waiting_for_approval':
        return 'AWAITING';
      case 'completed':
        return 'COMPLETED';
      case 'failed':
        return 'FAILED';
      case 'terminated':
        return 'TERMINATED';
      default:
        return 'INITIALIZING';
    }
  };

  return (
    <div className={`agent-terminal ${theme}`}>
      <div className="terminal-header">
        <div className="terminal-title">
          <span className="agent-role">{agent.role.name}</span>
          <span className="agent-id">#{agent.id.slice(-8)}</span>
        </div>
        <div className="terminal-status">
          <div 
            className="status-dot" 
            style={{ backgroundColor: getStatusColor() }}
          />
          <span className="status-text">{getStatusText()}</span>
        </div>
      </div>
      
      <div className="terminal-window" ref={terminalRef}>
        <div className="terminal-line">
          <span className="prompt">$</span>
          {currentLine}
          <span className={`cursor ${cursorVisible ? 'visible' : 'hidden'}`}>█</span>
        </div>
        
        {displayedOutput.map((line, index) => (
          <div key={index} className="terminal-line">
            <span className="prompt">$</span>
            <span className="output">{line}</span>
          </div>
        ))}
      </div>
    </div>
  );
};