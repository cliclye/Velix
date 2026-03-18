import React, { useCallback, useEffect, useRef, useState } from 'react';

export type NodeTone = 'queued' | 'mapping' | 'building' | 'review' | 'done' | 'blocked';

export interface MindMapPosition {
  x: number;
  y: number;
}

export interface MindMapConnection {
  from: string;
  to: string;
  kind?: 'automatic' | 'manual';
}

export interface MindMapNode {
  id: string;
  label: string;
  role: string;
  tone: NodeTone;
  workingOn?: string;
  statusLabel?: string;
  position?: MindMapPosition;
}

interface SwarmMindMapProps {
  nodes: MindMapNode[];
  connections?: MindMapConnection[];
  coordinatorStatus: string;
  isActive: boolean;
  onAgentClick?: (nodeId: string) => void;
  selectedNodeId?: string | null;
  onNodeMove?: (nodeId: string, position: MindMapPosition) => void;
  onConnect?: (fromNodeId: string, toNodeId: string) => void;
  onDisconnect?: (fromNodeId: string, toNodeId: string) => void;
  onDropRole?: (role: string, position: MindMapPosition) => void;
  dragDataKey?: string;
}

const TONE_COLORS: Record<NodeTone, string> = {
  queued: 'var(--text-hint)',
  mapping: 'var(--text-muted)',
  building: 'var(--text-secondary)',
  review: 'var(--accent-primary-dark)',
  done: 'var(--accent-primary)',
  blocked: 'var(--border-default)',
};

const ROLE_COLORS: Record<string, string> = {
  scout: 'var(--text-muted)',
  builder: 'var(--text-primary)',
  reviewer: 'var(--text-secondary)',
};

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.2;
const DRAG_THRESHOLD = 4;
const COORDINATOR_WIDTH = 210;
const COORDINATOR_HEIGHT = 84;
const NODE_WIDTH = 196;
const NODE_HEIGHT = 102;
const NODE_VISIBLE_EDGE_X = 28;
const NODE_VISIBLE_EDGE_Y = 22;

interface CanvasPoint {
  x: number;
  y: number;
}

interface ResolvedMindMapNode extends MindMapNode {
  center: CanvasPoint;
  roleColor: string;
  statusColor: string;
}

interface InteractionState {
  mode: 'idle' | 'pan' | 'node' | 'connect';
  pointerId: number | null;
  startClientX: number;
  startClientY: number;
  initialPanX: number;
  initialPanY: number;
  nodeId?: string;
  nodeOffsetX?: number;
  nodeOffsetY?: number;
  fromNodeId?: string;
  moved: boolean;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

const truncateText = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

export const buildDefaultMindMapPosition = (index: number, total: number): MindMapPosition => {
  const safeTotal = Math.max(total, 1);
  const cols = safeTotal <= 3 ? safeTotal : safeTotal <= 8 ? 4 : 5;
  const rows = Math.ceil(safeTotal / cols);
  const row = Math.floor(index / cols);
  const isLastRow = row === rows - 1;
  const nodesInRow = isLastRow ? safeTotal - row * cols : cols;
  const col = index - row * cols;
  const xStep = 0.74 / Math.max(nodesInRow - 1, 1);
  const x = nodesInRow === 1 ? 0.5 : 0.13 + col * xStep;
  const yStep = rows === 1 ? 0 : 0.54 / Math.max(rows - 1, 1);
  const y = 0.28 + row * yStep;

  return {
    x: clamp(x, 0.05, 0.95),
    y: clamp(y, 0.20, 0.95),
  };
};

const buildCurvePath = (from: CanvasPoint, to: CanvasPoint): string => {
  const horizontalDistance = Math.abs(to.x - from.x);
  const controlOffset = Math.max(56, horizontalDistance * 0.36);
  return [
    `M ${from.x} ${from.y}`,
    `C ${from.x + controlOffset} ${from.y}, ${to.x - controlOffset} ${to.y}, ${to.x} ${to.y}`,
  ].join(' ');
};

const formatTone = (value: string): string => value.toUpperCase();

export const SwarmMindMap: React.FC<SwarmMindMapProps> = ({
  nodes,
  connections = [],
  coordinatorStatus,
  isActive,
  onAgentClick,
  selectedNodeId,
  onNodeMove,
  onConnect,
  onDisconnect,
  onDropRole,
  dragDataKey,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const panRef = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const interactionRef = useRef<InteractionState>({
    mode: 'idle',
    pointerId: null,
    startClientX: 0,
    startClientY: 0,
    initialPanX: 0,
    initialPanY: 0,
    moved: false,
  });
  const suppressClickRef = useRef<string | null>(null);

  const [size, setSize] = useState({ w: 500, h: 400 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [isDropActive, setIsDropActive] = useState(false);
  const [connectionPreview, setConnectionPreview] = useState<{
    fromNodeId: string;
    point: CanvasPoint;
  } | null>(null);

  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setSize({
        w: Math.max(entry.contentRect.width, 320),
        h: Math.max(entry.contentRect.height, 240),
      });
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const coordinatorCenter = {
    x: size.w / 2,
    y: Math.max(COORDINATOR_HEIGHT / 2 + 18, Math.min(86, size.h * 0.18)),
  };

  const normalizeCanvasPoint = useCallback((point: CanvasPoint): MindMapPosition => ({
    x: point.x / size.w,
    y: point.y / size.h,
  }), [size.h, size.w]);

  const denormalizeCanvasPoint = useCallback((point: MindMapPosition): CanvasPoint => ({
    x: point.x * size.w,
    y: point.y * size.h,
  }), [size.h, size.w]);

  const getCanvasPointFromClient = useCallback((clientX: number, clientY: number): CanvasPoint | null => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;

    return {
      x: (clientX - rect.left - panRef.current.x) / zoomRef.current,
      y: (clientY - rect.top - panRef.current.y) / zoomRef.current,
    };
  }, []);

  const clampNodeCenter = useCallback((point: CanvasPoint): CanvasPoint => {
    // Keep a thin sliver of the card visible so nodes can sit on the edge
    // without getting lost entirely outside the canvas.
    const minX = -NODE_WIDTH / 2 + NODE_VISIBLE_EDGE_X;
    const maxX = Math.max(minX, size.w + NODE_WIDTH / 2 - NODE_VISIBLE_EDGE_X);
    const minY = -NODE_HEIGHT / 2 + NODE_VISIBLE_EDGE_Y;
    const maxY = Math.max(minY, size.h + NODE_HEIGHT / 2 - NODE_VISIBLE_EDGE_Y);

    return {
      x: clamp(point.x, minX, maxX),
      y: clamp(point.y, minY, maxY),
    };
  }, [size.h, size.w]);

  const getDroppedRole = useCallback((dataTransfer: DataTransfer): string => {
    const candidates = [
      dragDataKey ? dataTransfer.getData(dragDataKey) : '',
      dataTransfer.getData('text/plain'),
      dataTransfer.getData('text'),
      dataTransfer.getData('public.utf8-plain-text'),
      dataTransfer.getData('public.text'),
    ];

    return candidates
      .map((value) => value.trim().toLowerCase())
      .find((value) => value === 'scout' || value === 'builder' || value === 'reviewer') || '';
  }, [dragDataKey]);

  const isRoleDrag = useCallback((dataTransfer: DataTransfer): boolean => {
    const types = Array.from(dataTransfer.types || []);
    return types.includes(dragDataKey || '')
      || types.includes('text/plain')
      || types.includes('text')
      || types.includes('public.utf8-plain-text')
      || types.includes('public.text');
  }, [dragDataKey]);

  const zoomAtPoint = useCallback((nextZoom: number, clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const canvasX = (clientX - rect.left - panRef.current.x) / zoomRef.current;
    const canvasY = (clientY - rect.top - panRef.current.y) / zoomRef.current;

    setZoom(nextZoom);
    setPan({
      x: clientX - rect.left - canvasX * nextZoom,
      y: clientY - rect.top - canvasY * nextZoom,
    });
  }, []);

  const handleWheel = useCallback((event: WheelEvent) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.12 : 0.9;
    const nextZoom = clamp(Number((zoomRef.current * factor).toFixed(2)), MIN_ZOOM, MAX_ZOOM);
    zoomAtPoint(nextZoom, event.clientX, event.clientY);
  }, [zoomAtPoint]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => element.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  const resolvedNodes: ResolvedMindMapNode[] = nodes.map((node, index) => {
    const center = denormalizeCanvasPoint(node.position || buildDefaultMindMapPosition(index, nodes.length));
    return {
      ...node,
      center,
      roleColor: ROLE_COLORS[node.role] ?? '#6B7280',
      statusColor: TONE_COLORS[node.tone],
    };
  });

  const nodesById = new Map(resolvedNodes.map((node) => [node.id, node]));
  const incomingNodeIds = new Set(connections.map((connection) => connection.to));
  const rootNodes = resolvedNodes.filter((node) => !incomingNodeIds.has(node.id));

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const interaction = interactionRef.current;
      if (interaction.mode === 'idle') return;
      if (interaction.pointerId !== null && interaction.pointerId !== event.pointerId) return;

      const deltaX = event.clientX - interaction.startClientX;
      const deltaY = event.clientY - interaction.startClientY;
      if (Math.abs(deltaX) > DRAG_THRESHOLD || Math.abs(deltaY) > DRAG_THRESHOLD) {
        interaction.moved = true;
      }

      if (interaction.mode === 'pan') {
        setPan({
          x: interaction.initialPanX + deltaX,
          y: interaction.initialPanY + deltaY,
        });
        return;
      }

      const canvasPoint = getCanvasPointFromClient(event.clientX, event.clientY);
      if (!canvasPoint) return;

      if (interaction.mode === 'node' && interaction.nodeId) {
        const nextCenter = clampNodeCenter({
          x: canvasPoint.x - (interaction.nodeOffsetX || 0),
          y: canvasPoint.y - (interaction.nodeOffsetY || 0),
        });
        onNodeMove?.(interaction.nodeId, normalizeCanvasPoint(nextCenter));
        return;
      }

      if (interaction.mode === 'connect' && interaction.fromNodeId) {
        setConnectionPreview({
          fromNodeId: interaction.fromNodeId,
          point: canvasPoint,
        });
      }
    };

    const finishInteraction = (event: PointerEvent) => {
      const interaction = interactionRef.current;
      if (interaction.mode === 'idle') return;
      if (interaction.pointerId !== null && interaction.pointerId !== event.pointerId) return;

      if (interaction.mode === 'connect' && interaction.fromNodeId) {
        const targetElement = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
        const targetNode = targetElement?.closest('[data-smm-node-id]') as HTMLElement | null;
        const targetNodeId = targetNode?.dataset.smmNodeId;

        if (targetNodeId && targetNodeId !== interaction.fromNodeId) {
          onConnect?.(interaction.fromNodeId, targetNodeId);
        }
      }

      if (interaction.mode === 'node' && interaction.nodeId && interaction.moved) {
        suppressClickRef.current = interaction.nodeId;
      }

      interactionRef.current = {
        mode: 'idle',
        pointerId: null,
        startClientX: 0,
        startClientY: 0,
        initialPanX: 0,
        initialPanY: 0,
        moved: false,
      };
      setIsPanning(false);
      setConnectionPreview(null);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishInteraction);
    window.addEventListener('pointercancel', finishInteraction);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishInteraction);
      window.removeEventListener('pointercancel', finishInteraction);
    };
  }, [clampNodeCenter, getCanvasPointFromClient, normalizeCanvasPoint, onConnect, onNodeMove]);

  const startBackgroundPan = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;

    const target = event.target as HTMLElement;
    if (
      target.closest('.smm-agent-node') ||
      target.closest('.smm-zoom-controls') ||
      target.closest('.smm-link-line')
    ) {
      return;
    }

    interactionRef.current = {
      mode: 'pan',
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      initialPanX: panRef.current.x,
      initialPanY: panRef.current.y,
      moved: false,
    };
    setIsPanning(true);
    event.preventDefault();
  }, []);

  const startNodeDrag = useCallback((event: React.PointerEvent<HTMLDivElement>, node: ResolvedMindMapNode) => {
    if (event.button !== 0) return;

    const target = event.target as HTMLElement;
    if (target.closest('.smm-node-port')) return;

    const canvasPoint = getCanvasPointFromClient(event.clientX, event.clientY);
    if (!canvasPoint) return;

    interactionRef.current = {
      mode: 'node',
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      initialPanX: panRef.current.x,
      initialPanY: panRef.current.y,
      nodeId: node.id,
      nodeOffsetX: canvasPoint.x - node.center.x,
      nodeOffsetY: canvasPoint.y - node.center.y,
      moved: false,
    };
    event.preventDefault();
    event.stopPropagation();
  }, [getCanvasPointFromClient]);

  const startConnectionDrag = useCallback((event: React.PointerEvent<HTMLButtonElement>, nodeId: string) => {
    if (event.button !== 0) return;

    const canvasPoint = getCanvasPointFromClient(event.clientX, event.clientY);
    if (!canvasPoint) return;

    interactionRef.current = {
      mode: 'connect',
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      initialPanX: panRef.current.x,
      initialPanY: panRef.current.y,
      fromNodeId: nodeId,
      moved: true,
    };
    setConnectionPreview({
      fromNodeId: nodeId,
      point: canvasPoint,
    });
    event.preventDefault();
    event.stopPropagation();
  }, [getCanvasPointFromClient]);

  const handleRoleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!dragDataKey || !onDropRole) return;

    if (isRoleDrag(event.dataTransfer)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setIsDropActive(true);
    }
  }, [dragDataKey, isRoleDrag, onDropRole]);

  const handleRoleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const relatedTarget = event.relatedTarget as Node | null;
    if (!relatedTarget || !event.currentTarget.contains(relatedTarget)) {
      setIsDropActive(false);
    }
  }, []);

  const handleRoleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!dragDataKey || !onDropRole) return;

    const role = getDroppedRole(event.dataTransfer);
    if (!role) return;

    event.preventDefault();
    setIsDropActive(false);

    const canvasPoint = getCanvasPointFromClient(event.clientX, event.clientY);
    if (!canvasPoint) return;

    onDropRole(role, normalizeCanvasPoint(clampNodeCenter(canvasPoint)));
  }, [clampNodeCenter, dragDataKey, getCanvasPointFromClient, getDroppedRole, normalizeCanvasPoint, onDropRole]);

  const handleZoomButton = useCallback((direction: 'in' | 'out' | 'reset') => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    if (direction === 'reset') {
      setZoom(1);
      setPan({ x: 0, y: 0 });
      return;
    }

    const factor = direction === 'in' ? 1.15 : 0.87;
    const nextZoom = clamp(Number((zoomRef.current * factor).toFixed(2)), MIN_ZOOM, MAX_ZOOM);
    zoomAtPoint(nextZoom, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }, [zoomAtPoint]);

  return (
    <div
      ref={containerRef}
      className={`swarm-mindmap${isPanning ? ' smm-dragging' : ''}`}
      onPointerDown={startBackgroundPan}
      onDragOver={handleRoleDragOver}
      onDragLeave={handleRoleDragLeave}
      onDrop={handleRoleDrop}
    >
      <div className="smm-zoom-controls">
        <button
          type="button"
          className="smm-zoom-btn"
          onClick={() => handleZoomButton('in')}
          title="Zoom in"
        >
          +
        </button>
        <span className="smm-zoom-label">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          className="smm-zoom-btn"
          onClick={() => handleZoomButton('out')}
          title="Zoom out"
        >
          −
        </button>
        <button
          type="button"
          className="smm-zoom-btn"
          onClick={() => handleZoomButton('reset')}
          title="Reset view"
        >
          ⌂
        </button>
      </div>

      <div
        className="smm-viewport"
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0' }}
      >
        <svg className="smm-bg" width={size.w} height={size.h} aria-hidden="true">
          <defs>
            <pattern id="smm-dot-grid" width="24" height="24" patternUnits="userSpaceOnUse">
              <circle cx="1.25" cy="1.25" r="1.25" fill="currentColor" />
            </pattern>
          </defs>
          <rect width={size.w} height={size.h} fill="url(#smm-dot-grid)" />
        </svg>

        <svg className="smm-wires" width={size.w} height={size.h} aria-hidden="true">
          <defs>
            <marker
              id="smm-arrowhead"
              markerWidth="10"
              markerHeight="10"
              refX="8"
              refY="5"
              orient="auto"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
            </marker>
          </defs>

          {rootNodes.map((node) => {
            const path = buildCurvePath(
              { x: coordinatorCenter.x, y: coordinatorCenter.y + COORDINATOR_HEIGHT / 2 },
              { x: node.center.x, y: node.center.y - NODE_HEIGHT / 2 },
            );
            return (
              <path
                key={`root-${node.id}`}
                d={path}
                className="smm-root-link"
                stroke={node.statusColor}
                strokeWidth="1.4"
                fill="none"
                markerEnd="url(#smm-arrowhead)"
              />
            );
          })}

          {connections.map((connection) => {
            const fromNode = nodesById.get(connection.from);
            const toNode = nodesById.get(connection.to);
            if (!fromNode || !toNode) return null;

            const isSelected = selectedNodeId === fromNode.id || selectedNodeId === toNode.id;
            const path = buildCurvePath(
              { x: fromNode.center.x + NODE_WIDTH / 2, y: fromNode.center.y },
              { x: toNode.center.x - NODE_WIDTH / 2, y: toNode.center.y },
            );

            return (
              <path
                key={`${connection.from}-${connection.to}`}
                d={path}
                className={`smm-link-line${connection.kind === 'manual' ? ' smm-link-manual' : ' smm-link-automatic'}${isSelected ? ' smm-link-selected' : ''}`}
                stroke={fromNode.statusColor}
                strokeWidth={connection.kind === 'manual' ? 2.3 : 1.6}
                fill="none"
                markerEnd="url(#smm-arrowhead)"
                strokeDasharray={connection.kind === 'manual' ? undefined : '8 6'}
                onClick={
                  connection.kind === 'manual' && onDisconnect
                    ? (event) => {
                        event.stopPropagation();
                        onDisconnect(connection.from, connection.to);
                      }
                    : undefined
                }
              />
            );
          })}

          {connectionPreview && (() => {
            const fromNode = nodesById.get(connectionPreview.fromNodeId);
            if (!fromNode) return null;

            const path = buildCurvePath(
              { x: fromNode.center.x + NODE_WIDTH / 2, y: fromNode.center.y },
              connectionPreview.point,
            );

            return (
              <path
                d={path}
                className="smm-link-preview"
                stroke={fromNode.statusColor}
                strokeWidth="2.4"
                fill="none"
              />
            );
          })()}
        </svg>

        <div
          className={`smm-node smm-coordinator-node${isActive ? ' smm-active' : ''}`}
          style={{
            left: coordinatorCenter.x,
            top: coordinatorCenter.y,
            width: COORDINATOR_WIDTH,
            height: COORDINATOR_HEIGHT,
          }}
        >
          <div className="smm-coordinator-card">
            <span className="smm-coordinator-label">Coordinator</span>
            <strong>Swarm control lane</strong>
            <span className="smm-coordinator-status">
              {truncateText(coordinatorStatus || 'Idle', 24)}
            </span>
          </div>
        </div>

        {resolvedNodes.map((node) => {
          const isSelected = node.id === selectedNodeId;
          const isRunning = node.tone !== 'queued' && node.tone !== 'done' && node.tone !== 'blocked';
          const title = node.workingOn
            ? `${node.label}: ${node.workingOn}`
            : node.label;

          return (
            <div
              key={node.id}
              data-smm-node-id={node.id}
              className={`smm-node smm-agent-node${isRunning ? ' smm-running' : ''}${isSelected ? ' smm-selected' : ''}`}
              style={{
                left: node.center.x,
                top: node.center.y,
                width: NODE_WIDTH,
                height: NODE_HEIGHT,
                '--role-color': node.roleColor,
                '--status-color': node.statusColor,
              } as React.CSSProperties}
              onPointerDown={(event) => startNodeDrag(event, node)}
              onClick={() => {
                if (suppressClickRef.current === node.id) {
                  suppressClickRef.current = null;
                  return;
                }
                onAgentClick?.(node.id);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onAgentClick?.(node.id);
                }
              }}
              role={onAgentClick ? 'button' : undefined}
              tabIndex={onAgentClick ? 0 : undefined}
              title={title}
            >
              <span className="smm-node-port smm-node-port-in" aria-hidden="true" />
              <button
                type="button"
                className="smm-node-port smm-node-port-out"
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => startConnectionDrag(event, node.id)}
                title={`Connect ${node.label}`}
                aria-label={`Connect ${node.label}`}
              />

              <div className="smm-agent-card-shell">
                <div className="smm-agent-node-head">
                  <span className="smm-agent-node-role">{node.role}</span>
                  <span className="smm-node-badge" style={{ background: node.statusColor }}>
                    {node.statusLabel || formatTone(node.tone)}
                  </span>
                </div>

                <strong className="smm-agent-node-title">{truncateText(node.label, 24)}</strong>
                <span className="smm-agent-node-caption">Working on</span>
                <span className="smm-agent-node-work">
                  {truncateText(node.workingOn || 'Awaiting launch', 32)}
                </span>
              </div>
            </div>
          );
        })}

        {nodes.length === 0 && (
          <div className="smm-empty">
            <div className="smm-empty-glyph">⬡</div>
            <span>Drag roles into the map to place agents before launch.</span>
          </div>
        )}
      </div>

      {isDropActive && (
        <div className="smm-drop-overlay" aria-hidden="true">
          <span className="smm-drop-overlay-label">Drop to place agent</span>
        </div>
      )}
    </div>
  );
};
