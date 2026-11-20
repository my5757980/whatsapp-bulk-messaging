import type { FlowGraph } from '@wbm/shared';
import { useCallback, useReducer } from 'react';

/** Undo keeps the last 20 changes (FR-005). */
export const HISTORY_LIMIT = 20;
/** Edits of one field closer together than this count as one undo step (typing a word). */
const MERGE_MS = 1000;

interface HistoryState {
  graph: FlowGraph;
  past: FlowGraph[];
  future: FlowGraph[];
  lastKey: string | null;
  lastAt: number;
}

type HistoryAction =
  | { type: 'change'; update: (graph: FlowGraph) => FlowGraph; key: string | null; at: number }
  | { type: 'undo' }
  | { type: 'redo' };

function reducer(state: HistoryState, action: HistoryAction): HistoryState {
  switch (action.type) {
    case 'change': {
      const graph = action.update(state.graph);
      if (graph === state.graph) return state;
      const merge = action.key !== null && action.key === state.lastKey && action.at - state.lastAt < MERGE_MS;
      return {
        graph,
        past: merge ? state.past : [...state.past, state.graph].slice(-HISTORY_LIMIT),
        future: [],
        lastKey: action.key,
        lastAt: action.at,
      };
    }
    case 'undo': {
      const previous = state.past.at(-1);
      if (!previous) return state;
      return { graph: previous, past: state.past.slice(0, -1), future: [state.graph, ...state.future].slice(0, HISTORY_LIMIT), lastKey: null, lastAt: 0 };
    }
    case 'redo': {
      const [next, ...rest] = state.future;
      if (!next) return state;
      return { graph: next, past: [...state.past, state.graph].slice(-HISTORY_LIMIT), future: rest, lastKey: null, lastAt: 0 };
    }
  }
}

/** Applies a change to the graph; `key` names the edited field so rapid edits merge into one undo step. */
export type GraphChange = (update: (graph: FlowGraph) => FlowGraph, key?: string) => void;

/** The graph being edited, with undo and redo. */
export function useGraphHistory(initial: FlowGraph) {
  const [state, dispatch] = useReducer(reducer, initial, (graph): HistoryState => ({ graph, past: [], future: [], lastKey: null, lastAt: 0 }));
  const change = useCallback<GraphChange>((update, key) => dispatch({ type: 'change', update, key: key ?? null, at: Date.now() }), []);
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const redo = useCallback(() => dispatch({ type: 'redo' }), []);
  return { graph: state.graph, change, undo, redo, canUndo: state.past.length > 0, canRedo: state.future.length > 0 };
}
