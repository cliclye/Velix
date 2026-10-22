import { useEffect, useState, useSyncExternalStore } from 'react';
import { swarmSession, type SwarmSnapshot } from '../services/swarm';

/** Subscribe a component to the live swarm run (which lives outside React). */
export function useSwarmSession(): SwarmSnapshot {
  return useSyncExternalStore(swarmSession.subscribe, swarmSession.getSnapshot);
}

/** Re-render every `intervalMs` while `active` — for live elapsed timers. */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}
