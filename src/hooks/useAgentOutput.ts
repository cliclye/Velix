/**
 * useAgentOutput - React hook for subscribing to agent output streams
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { orchestrator } from '../services/swarm';

interface UseAgentOutputOptions {
  agentId?: string;
  maxLines?: number;
  autoScroll?: boolean;
}

interface UseAgentOutputReturn {
  output: string[];
  lastLine: string | null;
  clearOutput: () => void;
  isActive: boolean;
}

export function useAgentOutput(options: UseAgentOutputOptions = {}): UseAgentOutputReturn {
  const { agentId, maxLines = 1000, autoScroll: _autoScroll = true } = options;

  const [output, setOutput] = useState<string[]>([]);
  const [isActive, setIsActive] = useState(false);
  const outputRef = useRef<string[]>([]);

  // Subscribe to agent output
  useEffect(() => {
    const manager = orchestrator.getAgentManager();
    if (!manager) return;

    const unsubscribe = manager.onAgentOutput((outputAgentId, data) => {
      // Filter by agent ID if specified
      if (agentId && outputAgentId !== agentId) return;

      // Split data into lines
      const lines = data.split('\n').filter((line) => line.length > 0);

      // Update output buffer
      outputRef.current = [...outputRef.current, ...lines];
      if (outputRef.current.length > maxLines) {
        outputRef.current = outputRef.current.slice(-maxLines);
      }

      setOutput([...outputRef.current]);
      setIsActive(true);
    });

    return unsubscribe;
  }, [agentId, maxLines]);

  // Subscribe to agent exit
  useEffect(() => {
    const manager = orchestrator.getAgentManager();
    if (!manager) return;

    const unsubscribe = manager.onAgentExit((exitAgentId) => {
      if (!agentId || exitAgentId === agentId) {
        setIsActive(false);
      }
    });

    return unsubscribe;
  }, [agentId]);

  // Clear output
  const clearOutput = useCallback(() => {
    outputRef.current = [];
    setOutput([]);
  }, []);

  // Get last line
  const lastLine = output.length > 0 ? output[output.length - 1] : null;

  return {
    output,
    lastLine,
    clearOutput,
    isActive,
  };
}

/**
 * useAllAgentsOutput - Subscribe to output from all agents
 */
export function useAllAgentsOutput(maxLinesPerAgent: number = 100): {
  outputs: Map<string, string[]>;
  getAgentOutput: (agentId: string) => string[];
  clearAllOutput: () => void;
} {
  const [outputs, setOutputs] = useState<Map<string, string[]>>(new Map());
  const outputsRef = useRef<Map<string, string[]>>(new Map());

  useEffect(() => {
    const manager = orchestrator.getAgentManager();
    if (!manager) return;

    const unsubscribe = manager.onAgentOutput((agentId, data) => {
      const lines = data.split('\n').filter((line) => line.length > 0);

      const currentOutput = outputsRef.current.get(agentId) || [];
      const newOutput = [...currentOutput, ...lines].slice(-maxLinesPerAgent);

      outputsRef.current.set(agentId, newOutput);
      setOutputs(new Map(outputsRef.current));
    });

    return unsubscribe;
  }, [maxLinesPerAgent]);

  const getAgentOutput = useCallback((agentId: string): string[] => {
    return outputs.get(agentId) || [];
  }, [outputs]);

  const clearAllOutput = useCallback(() => {
    outputsRef.current.clear();
    setOutputs(new Map());
  }, []);

  return {
    outputs,
    getAgentOutput,
    clearAllOutput,
  };
}
