/**
 * SwarmEventEmitter - Event system for swarm orchestration
 * Provides publish/subscribe pattern for swarm events
 */

import { SwarmEvent, AgentEvent, OrchestratorState } from './types';

type EventCallback<T = SwarmEvent> = (event: T) => void;

interface Subscription {
  id: string;
  callback: EventCallback;
  filter?: (event: SwarmEvent) => boolean;
}

export class SwarmEventEmitter {
  private subscriptions: Map<string, Subscription> = new Map();
  private eventHistory: SwarmEvent[] = [];
  private maxHistorySize: number = 1000;
  private subscriptionCounter: number = 0;

  /**
   * Subscribe to all swarm events
   */
  subscribe(callback: EventCallback, filter?: (event: SwarmEvent) => boolean): () => void {
    const id = `sub_${++this.subscriptionCounter}`;
    this.subscriptions.set(id, { id, callback, filter });

    // Return unsubscribe function
    return () => {
      this.subscriptions.delete(id);
    };
  }

  /**
   * Subscribe to specific event types only
   */
  subscribeToType<T extends SwarmEvent['type']>(
    eventType: T,
    callback: (event: Extract<SwarmEvent, { type: T }>) => void
  ): () => void {
    return this.subscribe(
      (event) => callback(event as Extract<SwarmEvent, { type: T }>),
      (event) => event.type === eventType
    );
  }

  /**
   * Subscribe to agent events only
   */
  subscribeToAgentEvents(
    callback: (event: AgentEvent, agentId?: string) => void,
    agentId?: string
  ): () => void {
    return this.subscribe(
      (event) => {
        if (event.type === 'agent_event') {
          callback(event.event, event.event.agentId);
        }
      },
      (event) => {
        if (event.type !== 'agent_event') return false;
        if (agentId && 'agentId' in event.event) {
          return event.event.agentId === agentId;
        }
        return true;
      }
    );
  }

  /**
   * Subscribe to state changes only
   */
  subscribeToStateChanges(
    callback: (from: OrchestratorState, to: OrchestratorState) => void
  ): () => void {
    return this.subscribeToType('state_changed', (event) => {
      callback(event.from, event.to);
    });
  }

  /**
   * Emit an event to all subscribers
   */
  emit(event: SwarmEvent): void {
    // Add to history
    this.eventHistory.push(event);
    if (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory.shift();
    }

    // Notify subscribers
    for (const subscription of this.subscriptions.values()) {
      try {
        if (!subscription.filter || subscription.filter(event)) {
          subscription.callback(event);
        }
      } catch (error) {
        console.error('SwarmEventEmitter: Error in subscriber callback:', error);
      }
    }
  }

  /**
   * Emit a state change event
   */
  emitStateChange(from: OrchestratorState, to: OrchestratorState): void {
    this.emit({ type: 'state_changed', from, to });
  }

  /**
   * Emit an agent event wrapped in a swarm event
   */
  emitAgentEvent(event: AgentEvent): void {
    this.emit({ type: 'agent_event', event });
  }

  /**
   * Get recent event history
   */
  getHistory(count?: number): SwarmEvent[] {
    if (count) {
      return this.eventHistory.slice(-count);
    }
    return [...this.eventHistory];
  }

  /**
   * Get events by type from history
   */
  getHistoryByType<T extends SwarmEvent['type']>(
    eventType: T,
    count?: number
  ): Extract<SwarmEvent, { type: T }>[] {
    const filtered = this.eventHistory.filter(
      (e) => e.type === eventType
    ) as Extract<SwarmEvent, { type: T }>[];

    if (count) {
      return filtered.slice(-count);
    }
    return filtered;
  }

  /**
   * Clear event history
   */
  clearHistory(): void {
    this.eventHistory = [];
  }

  /**
   * Set maximum history size
   */
  setMaxHistorySize(size: number): void {
    this.maxHistorySize = size;
    if (this.eventHistory.length > size) {
      this.eventHistory = this.eventHistory.slice(-size);
    }
  }

  /**
   * Get subscriber count
   */
  getSubscriberCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Remove all subscribers
   */
  clearSubscriptions(): void {
    this.subscriptions.clear();
  }

  /**
   * Wait for a specific event type
   */
  waitForEvent<T extends SwarmEvent['type']>(
    eventType: T,
    timeout?: number
  ): Promise<Extract<SwarmEvent, { type: T }>> {
    return new Promise((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const unsubscribe = this.subscribeToType(eventType, (event) => {
        if (timeoutId) clearTimeout(timeoutId);
        unsubscribe();
        resolve(event);
      });

      if (timeout) {
        timeoutId = setTimeout(() => {
          unsubscribe();
          reject(new Error(`Timeout waiting for event: ${eventType}`));
        }, timeout);
      }
    });
  }

  /**
   * Wait for orchestrator to reach a specific state
   */
  waitForState(
    targetState: OrchestratorState,
    timeout?: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;

      const unsubscribe = this.subscribeToStateChanges((_from, to) => {
        if (to === targetState) {
          if (timeoutId) clearTimeout(timeoutId);
          unsubscribe();
          resolve();
        }
      });

      if (timeout) {
        timeoutId = setTimeout(() => {
          unsubscribe();
          reject(new Error(`Timeout waiting for state: ${targetState}`));
        }, timeout);
      }
    });
  }
}

// Singleton instance
export const swarmEvents = new SwarmEventEmitter();
