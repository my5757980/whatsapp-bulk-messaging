'use client';

import { branchesOf, type FlowGraph, type Problem } from '@wbm/shared';
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Connection,
  type Dimensions,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type OnDelete,
  type OnNodeDrag,
  type XYPosition,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMemo, useState } from 'react';
import { problemsByStep, removeStep, setBranch } from '@/lib/flows';
import { StepNode, type StepNodeType } from './steps/step-node';
import type { StepStats } from './analytics-overlay';
import type { GraphChange } from './use-graph-history';

const NODE_TYPES = { step: StepNode };
const ARROW = { type: MarkerType.ArrowClosed } as const;

interface FlowCanvasProps {
  graph: FlowGraph;
  problems: Problem[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: GraphChange;
  /** Analytics mode: counts per step (003 US8). */
  stats?: Map<string, StepStats>;
}

/**
 * React Flow canvas over the graph (003 T027): steps are nodes, branches are edges. The graph is
 * the source of truth; positions are written back when a drag ends, so a drag is one undo step.
 */
export function FlowCanvas({ graph, problems, selectedId, onSelect, onChange, stats }: FlowCanvasProps) {
  const [measured, setMeasured] = useState<Record<string, Dimensions>>({});
  const [dragging, setDragging] = useState<Record<string, XYPosition>>({});
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const problemMap = useMemo(() => problemsByStep(problems), [problems]);

  const nodes = useMemo<StepNodeType[]>(
    () =>
      graph.steps.map((step) => {
        const size = measured[step.id];
        const moving = dragging[step.id];
        return {
          id: step.id,
          type: 'step' as const,
          position: moving ?? step.position,
          data: { step, isStart: graph.start === step.id, problems: problemMap.get(step.id) ?? [], stats: stats ? (stats.get(step.id) ?? { entered: 0, continued: 0, dropped: 0, options: [] }) : null },
          selected: step.id === selectedId,
          dragging: moving !== undefined,
          ...(size ? { measured: size } : {}),
        };
      }),
    [graph, problemMap, selectedId, dragging, measured, stats],
  );

  const edges = useMemo<Edge[]>(() => {
    const ids = new Set(graph.steps.map((s) => s.id));
    return graph.steps.flatMap((step) =>
      branchesOf(step).flatMap((exit) => {
        if (exit.target === null || !ids.has(exit.target)) return [];
        const id = `${step.id}:${exit.branch}`;
        return [{ id, source: step.id, sourceHandle: exit.branch, target: exit.target, selected: id === selectedEdge, markerEnd: ARROW }];
      }),
    );
  }, [graph, selectedEdge]);

  function onNodesChange(changes: NodeChange<StepNodeType>[]) {
    const sizes: Record<string, Dimensions> = {};
    const moves: Record<string, XYPosition> = {};
    let picked: string | null | undefined;
    for (const change of changes) {
      if (change.type === 'dimensions' && change.dimensions) sizes[change.id] = change.dimensions;
      else if (change.type === 'position' && change.dragging && change.position) moves[change.id] = change.position;
      else if (change.type === 'select') {
        if (change.selected) picked = change.id;
        else if (change.id === selectedId && picked === undefined) picked = null;
      }
    }
    if (Object.keys(sizes).length) setMeasured((current) => ({ ...current, ...sizes }));
    if (Object.keys(moves).length) setDragging((current) => ({ ...current, ...moves }));
    if (picked !== undefined) onSelect(picked);
  }

  function onEdgesChange(changes: EdgeChange[]) {
    for (const change of changes) {
      if (change.type !== 'select') continue;
      if (change.selected) setSelectedEdge(change.id);
      else setSelectedEdge((current) => (current === change.id ? null : current));
    }
  }

  const onNodeDragStop: OnNodeDrag<StepNodeType> = (_event, _node, moved) => {
    const positions = new Map<string, XYPosition>();
    for (const node of moved) {
      const at = dragging[node.id] ?? node.position;
      const step = graph.steps.find((s) => s.id === node.id);
      const rounded = { x: Math.round(at.x), y: Math.round(at.y) };
      if (step && (step.position.x !== rounded.x || step.position.y !== rounded.y)) positions.set(node.id, rounded);
    }
    if (positions.size) onChange((g) => ({ ...g, steps: g.steps.map((s) => ({ ...s, position: positions.get(s.id) ?? s.position })) }));
    setDragging({});
  };

  function onConnect(connection: Connection) {
    const branch = connection.sourceHandle;
    if (!branch) return;
    onChange((g) => setBranch(g, connection.source, branch, connection.target));
  }

  const onDelete: OnDelete<StepNodeType, Edge> = ({ nodes: gone, edges: cut }) => {
    const goneIds = new Set(gone.map((n) => n.id));
    onChange((g) => {
      let next = g;
      for (const id of goneIds) next = removeStep(next, id);
      for (const edge of cut) {
        if (!goneIds.has(edge.source) && edge.sourceHandle) next = setBranch(next, edge.source, edge.sourceHandle, null);
      }
      return next;
    });
    if (selectedId && goneIds.has(selectedId)) onSelect(null);
    setSelectedEdge(null);
  };

  return (
    <ReactFlow<StepNodeType, Edge>
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onDelete={onDelete}
      onNodeDragStop={onNodeDragStop}
      onPaneClick={() => {
        onSelect(null);
        setSelectedEdge(null);
      }}
      deleteKeyCode={['Backspace', 'Delete']}
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
      minZoom={0.2}
      maxZoom={1.5}
    >
      <Background />
      <Controls />
      <MiniMap pannable zoomable />
    </ReactFlow>
  );
}
