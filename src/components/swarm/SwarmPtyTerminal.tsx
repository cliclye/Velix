import React, { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { invoke } from '../../platform/native';
import { Agent } from '../../services/swarm/types';
import '@xterm/xterm/css/xterm.css';
import './SwarmPtyTerminal.css';

interface SwarmPtyTerminalProps {
  agent: Agent;
  theme: 'light' | 'dark';
  className?: string;
  emptyText?: string;
  interactive?: boolean;
  resizeSession?: boolean;
  autoFocus?: boolean;
  onWriteInput?: (agentId: string, data: string) => void;
}

const DARK_TERMINAL_THEME = {
  background: '#0f1012',
  foreground: '#f2f2f3',
  cursor: '#f2f2f3',
  cursorAccent: '#0f1012',
  selectionBackground: 'rgba(242, 242, 243, 0.16)',
  selectionForeground: '#ffffff',
  black: '#0f1012',
  red: '#d6d7dc',
  green: '#ffffff',
  yellow: '#e5e7eb',
  blue: '#ffffff',
  magenta: '#e5e7eb',
  cyan: '#d6d7dc',
  white: '#cfd1d7',
  brightBlack: '#676a73',
  brightRed: '#d6d7dc',
  brightGreen: '#ffffff',
  brightYellow: '#e5e7eb',
  brightBlue: '#ffffff',
  brightMagenta: '#e5e7eb',
  brightCyan: '#d6d7dc',
  brightWhite: '#ffffff',
};

const LIGHT_TERMINAL_THEME = {
  background: '#f5f5f7',
  foreground: '#101114',
  cursor: '#111111',
  cursorAccent: '#f5f5f7',
  selectionBackground: 'rgba(17, 17, 17, 0.14)',
  selectionForeground: '#050506',
  black: '#101114',
  red: '#3a3c42',
  green: '#2d2e34',
  yellow: '#4d4f58',
  blue: '#111111',
  magenta: '#696b74',
  cyan: '#545660',
  white: '#6c6f78',
  brightBlack: '#91939c',
  brightRed: '#545660',
  brightGreen: '#111111',
  brightYellow: '#2d2e34',
  brightBlue: '#050506',
  brightMagenta: '#3a3c42',
  brightCyan: '#2d2e34',
  brightWhite: '#050506',
};

const RESIZE_DEBOUNCE_MS = 350;
const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 24;

export const SwarmPtyTerminal: React.FC<SwarmPtyTerminalProps> = ({
  agent,
  theme,
  className,
  emptyText = 'Waiting for output…',
  interactive = false,
  resizeSession = false,
  autoFocus = false,
  onWriteInput,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const renderedOutputRef = useRef('');
  const renderedEpochRef = useRef(0);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const followOutputRef = useRef(true);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      cursorBlink: interactive,
      cursorStyle: 'bar',
      disableStdin: !interactive,
      fontSize: 12,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', 'Menlo', 'Monaco', monospace",
      lineHeight: 1.05,
      scrollback: 10000,
      theme: theme === 'light' ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;

    const isViewportNearBottom = () => {
      const viewport = container.querySelector('.xterm-viewport');
      if (!(viewport instanceof HTMLDivElement)) return true;
      const remaining = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      return remaining <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX;
    };

    const scheduleResize = () => {
      if (!resizeSession) return;
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => {
        if (!terminalRef.current) return;
        void invoke('pty_resize', {
          sessionId: agent.sessionId,
          rows: terminalRef.current.rows,
          cols: terminalRef.current.cols,
        }).catch(() => {});
      }, RESIZE_DEBOUNCE_MS);
    };

    const fitTerminal = () => {
      const shouldStickToBottom = followOutputRef.current || isViewportNearBottom();
      fitAddon.fit();
      scheduleResize();
      if (shouldStickToBottom) {
        terminal.scrollToBottom();
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      fitTerminal();
    });
    resizeObserver.observe(container);

    const handleViewportScroll = () => {
      followOutputRef.current = isViewportNearBottom();
    };

    let detachViewportScroll: (() => void) | null = null;
    const attachViewportScroll = () => {
      const viewport = container.querySelector('.xterm-viewport');
      if (!(viewport instanceof HTMLDivElement)) return;
      viewport.addEventListener('scroll', handleViewportScroll, { passive: true });
      handleViewportScroll();
      detachViewportScroll = () => {
        viewport.removeEventListener('scroll', handleViewportScroll);
      };
    };

    const inputDisposable = interactive && onWriteInput
      ? terminal.onData((data) => {
          followOutputRef.current = true;
          onWriteInput(agent.id, data);
        })
      : null;

    requestAnimationFrame(() => {
      attachViewportScroll();
      fitTerminal();
    });

    return () => {
      if (resizeTimerRef.current) {
        clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = null;
      }
      detachViewportScroll?.();
      inputDisposable?.dispose();
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      renderedOutputRef.current = '';
      renderedEpochRef.current = 0;
      followOutputRef.current = true;
    };
  }, [agent.id, agent.sessionId, interactive, onWriteInput, resizeSession, theme]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const nextOutput = agent.terminalOutput || '';
    const previousOutput = renderedOutputRef.current;
    const outputEpoch = agent.terminalOutputEpoch ?? 0;
    const shouldStickToBottom = followOutputRef.current;

    if (!nextOutput) {
      terminal.reset();
      terminal.writeln(`\x1b[90m${emptyText}\x1b[0m`);
      renderedOutputRef.current = '';
      renderedEpochRef.current = outputEpoch;
      return;
    }

    if (
      outputEpoch !== renderedEpochRef.current
      || previousOutput.length === 0
      || !nextOutput.startsWith(previousOutput)
    ) {
      terminal.reset();
      terminal.write(nextOutput);
    } else {
      terminal.write(nextOutput.slice(previousOutput.length));
    }

    renderedOutputRef.current = nextOutput;
    renderedEpochRef.current = outputEpoch;
    if (shouldStickToBottom) {
      terminal.scrollToBottom();
    }
  }, [agent.id, agent.terminalOutput, agent.terminalOutputEpoch, emptyText, interactive, resizeSession, theme]);

  useEffect(() => {
    if (!autoFocus || !interactive) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    const timer = window.setTimeout(() => terminal.focus(), 60);
    return () => window.clearTimeout(timer);
  }, [agent.id, autoFocus, interactive]);

  return (
    <div
      className={`swarm-pty-terminal${interactive ? ' interactive' : ''}${className ? ` ${className}` : ''}`}
      onClick={() => {
        if (interactive) {
          terminalRef.current?.focus();
        }
      }}
    >
      <div ref={containerRef} className="swarm-pty-terminal-surface" />
    </div>
  );
};
