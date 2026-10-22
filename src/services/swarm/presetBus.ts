/**
 * Tiny hand-off so something outside the Swarm panel (the command palette) can ask it to
 * load a preset — even if the panel isn't mounted yet and only appears after the request.
 */

const EVENT = 'velix:swarm-preset';
let pending: string | null = null;

export function requestSwarmPreset(presetId: string): void {
  pending = presetId;
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function takePendingSwarmPreset(): string | null {
  const id = pending;
  pending = null;
  return id;
}

export function onSwarmPresetRequest(handler: () => void): () => void {
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
