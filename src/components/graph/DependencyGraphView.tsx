'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  ReactFlow,
  Controls,
  Background,
  MiniMap,
  useReactFlow,
  ReactFlowProvider,
  BackgroundVariant,
  Node,
} from '@xyflow/react';
import { Repository } from '@/types';
import { SymbolNode } from './SymbolNode';
import { PurposeNode } from './PurposeNode';
import { SymbolDetailsPanel } from './SymbolDetailsPanel';
import { GraphSearch } from './GraphSearch';
import { GraphFilters } from './GraphFilters';
import { GraphLegend } from './GraphLegend';
import { useGraph } from '@/lib/api/queries';
import {
  GraphApiResponse,
  GraphFilterState,
  GraphFocusState,
  GraphHierarchyState,
  DEFAULT_NODE_TYPES,
  ALL_RELATIONSHIP_TYPES,
  buildGraphViewModel,
  GraphApiNode,
} from './graphUtils';

export interface GraphPersistedUiState {
  filterState?: GraphFilterState;
  focusState?: GraphFocusState;
  hierarchyState?: GraphHierarchyState;
  selectedNodeId?: string | null;
  layoutDirection?: 'TB' | 'LR';
}

export interface DependencyGraphViewProps {
  repo: Repository;
  onSelectFile?: (filename: string, startLine?: number, endLine?: number) => void;
  onAskAi?: (prompt: string) => void;
  persistedUiState?: GraphPersistedUiState;
  onPersistUiState?: (state: GraphPersistedUiState) => void;
}

const nodeTypes: any = {
  purposeNode: PurposeNode,
  symbolNode: SymbolNode,
};

const DEFAULT_FILTERS: GraphFilterState = {
  nodeTypes: new Set(DEFAULT_NODE_TYPES),
  relationshipTypes: new Set(ALL_RELATIONSHIP_TYPES),
  includeMediumConfidence: false,
  includeMethods: false,
  maxInitialNodes: 50,
};

const DEFAULT_FOCUS: GraphFocusState = {
  focusedNodeId: null,
  expandedNodeIds: new Set<string>(),
};

const DEFAULT_HIERARCHY: GraphHierarchyState = {
  expandedPurposeIds: new Set<string>(),
  unfoldedNodeIds: new Set<string>(),
  viewLevel: 'purpose',
};

function InnerNodalGraphView({
  repo,
  onSelectFile,
  onAskAi,
  persistedUiState,
  onPersistUiState,
}: DependencyGraphViewProps) {
  const reactFlowInstance = useReactFlow();

  const { data: apiData, isLoading, error: queryError, refetch } = useGraph(repo.id);
  const error = queryError ? (queryError as Error).message : null;

  const [filterState, setFilterState] = useState<GraphFilterState>(
    persistedUiState?.filterState || DEFAULT_FILTERS
  );
  const [focusState, setFocusState] = useState<GraphFocusState>(
    persistedUiState?.focusState || DEFAULT_FOCUS
  );
  const [hierarchyState, setHierarchyState] = useState<GraphHierarchyState>(
    persistedUiState?.hierarchyState || DEFAULT_HIERARCHY
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    persistedUiState?.selectedNodeId !== undefined ? persistedUiState.selectedNodeId : null
  );
  const [layoutDirection, setLayoutDirection] = useState<'TB' | 'LR'>(
    persistedUiState?.layoutDirection || 'TB'
  );

  // Stable ref for onPersistUiState to prevent infinite re-render loops
  const onPersistUiStateRef = useRef(onPersistUiState);
  useEffect(() => {
    onPersistUiStateRef.current = onPersistUiState;
  }, [onPersistUiState]);

  // Sync state to parent on user changes (skipping initial mount)
  const isMountedRef = useRef(false);
  useEffect(() => {
    if (!isMountedRef.current) {
      isMountedRef.current = true;
      return;
    }
    onPersistUiStateRef.current?.({
      filterState,
      focusState,
      hierarchyState,
      selectedNodeId,
      layoutDirection,
    });
  }, [filterState, focusState, hierarchyState, selectedNodeId, layoutDirection]);

  // History stack for back navigation to last opened state
  const [history, setHistory] = useState<
    {
      hierarchyState: GraphHierarchyState;
      focusState: GraphFocusState;
      selectedNodeId: string | null;
    }[]
  >([]);

  const pushToHistory = useCallback(() => {
    setHistory((prev) => [
      ...prev.slice(-29),
      {
        hierarchyState: {
          expandedPurposeIds: new Set(hierarchyState.expandedPurposeIds),
          unfoldedNodeIds: new Set(hierarchyState.unfoldedNodeIds),
          viewLevel: hierarchyState.viewLevel,
        },
        focusState: {
          focusedNodeId: focusState.focusedNodeId,
          expandedNodeIds: new Set(focusState.expandedNodeIds),
        },
        selectedNodeId,
      },
    ]);
  }, [hierarchyState, focusState, selectedNodeId]);

  const handleBack = useCallback(() => {
    setHistory((prev) => {
      if (prev.length === 0) return prev;
      const nextHistory = [...prev];
      const previousSnapshot = nextHistory.pop()!;
      setHierarchyState(previousSnapshot.hierarchyState);
      setFocusState(previousSnapshot.focusState);
      setSelectedNodeId(previousSnapshot.selectedNodeId);
      return nextHistory;
    });
  }, []);

  // Toggle expanding a Purpose Node (Tier 1 -> Tier 2)
  const handleTogglePurposeExpand = useCallback((purposeId: string) => {
    pushToHistory();
    setHierarchyState((prev) => {
      const next = new Set(prev.expandedPurposeIds);
      if (next.has(purposeId)) {
        next.delete(purposeId);
      } else {
        next.add(purposeId);
      }
      return {
        ...prev,
        expandedPurposeIds: next,
      };
    });
  }, [pushToHistory]);

  // Toggle unfolding methods of a class (Tier 2 -> Tier 3)
  const handleToggleUnfold = useCallback((nodeId: string) => {
    pushToHistory();
    setHierarchyState((prev) => {
      const next = new Set(prev.unfoldedNodeIds);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return {
        ...prev,
        unfoldedNodeIds: next,
      };
    });
  }, [pushToHistory]);

  // Set hierarchy view level preset
  const handleSetViewLevel = useCallback((level: 'purpose' | 'classes' | 'full') => {
    pushToHistory();
    setHierarchyState((prev) => ({
      ...prev,
      viewLevel: level,
      expandedPurposeIds: level === 'purpose' ? new Set() : prev.expandedPurposeIds,
      unfoldedNodeIds: level === 'full' ? prev.unfoldedNodeIds : new Set(),
    }));
  }, [pushToHistory]);

  // 2. Transform API Data -> React Flow Nodes & Edges on filter, focus, or drilldown change
  const viewModel = useMemo(() => {
    if (!apiData) {
      return {
        nodes: [],
        edges: [],
        totalAvailableNodes: 0,
        displayedNodeCount: 0,
        isLimited: false,
        purposeClusters: [],
      };
    }
    return buildGraphViewModel(
      apiData,
      filterState,
      focusState,
      selectedNodeId,
      layoutDirection,
      hierarchyState,
      handleToggleUnfold,
      handleTogglePurposeExpand
    );
  }, [
    apiData,
    filterState,
    focusState,
    selectedNodeId,
    layoutDirection,
    hierarchyState,
    handleToggleUnfold,
    handleTogglePurposeExpand,
  ]);

  // Fit View debounce on structural change (NOT on every selection)
  const prevStructureCountRef = useRef<number>(0);
  useEffect(() => {
    const currentCount = viewModel.nodes.length;
    if (currentCount > 0 && currentCount !== prevStructureCountRef.current) {
      prevStructureCountRef.current = currentCount;
      const timer = setTimeout(() => {
        reactFlowInstance.fitView({ padding: 0.18, duration: 400, maxZoom: 1.05 });
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [viewModel.nodes.length, reactFlowInstance]);

  // Node selection handler
  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    if (node.type === 'purposeNode') {
      const purposeId = (node.data as any).purposeId;
      handleTogglePurposeExpand(purposeId);
      return;
    }
    if (node.id !== selectedNodeId) {
      pushToHistory();
      setSelectedNodeId(node.id);
    }
  }, [handleTogglePurposeExpand, selectedNodeId, pushToHistory]);

  const handleSelectNodeById = useCallback(
    (nodeId: string) => {
      pushToHistory();
      setSelectedNodeId(nodeId);
      // Activate Focus Mode directly to isolate the searched symbol + direct incoming & outgoing neighbors
      setFocusState({
        focusedNodeId: nodeId,
        expandedNodeIds: new Set<string>(),
      });
    },
    [pushToHistory]
  );

  // Focus Mode toggling
  const handleToggleFocus = useCallback((nodeId: string) => {
    pushToHistory();
    setFocusState((prev) => {
      if (prev.focusedNodeId === nodeId) {
        return DEFAULT_FOCUS;
      }
      return {
        focusedNodeId: nodeId,
        expandedNodeIds: new Set<string>(),
      };
    });
  }, [pushToHistory]);

  // Expand Node in Focus Mode
  const handleExpandNode = useCallback((nodeId: string) => {
    pushToHistory();
    setFocusState((prev) => {
      const nextExpanded = new Set(prev.expandedNodeIds);
      nextExpanded.add(nodeId);
      return {
        ...prev,
        expandedNodeIds: nextExpanded,
      };
    });
  }, [pushToHistory]);

  const handleResetFilters = useCallback(() => {
    pushToHistory();
    setFilterState(DEFAULT_FILTERS);
    setFocusState(DEFAULT_FOCUS);
    setHierarchyState(DEFAULT_HIERARCHY);
  }, [pushToHistory]);

  const selectedNodeData: GraphApiNode | null = useMemo(() => {
    if (!selectedNodeId || !apiData) return null;
    return apiData.nodes.find((n) => n.id === selectedNodeId) || null;
  }, [selectedNodeId, apiData]);

  // Empty state: No symbols detected
  if (!isLoading && apiData && apiData.nodes.length === 0) {
    return (
      <div className="w-full h-full min-h-[600px] rounded-3xl border border-[#48454d]/25 bg-gradient-to-b from-[#14161b] to-[#0d0e11] p-12 flex flex-col items-center justify-center text-center relative overflow-hidden select-none shadow-2xl">
        <div className="absolute inset-0 bg-dot-pattern opacity-30 pointer-events-none"></div>
        <div className="relative z-10 max-w-md space-y-4">
          <div className="w-16 h-16 rounded-2xl bg-[#1e2026] border border-[#48454d]/40 flex items-center justify-center text-[#938f98] mx-auto shadow-2xl">
            <span className="material-symbols-outlined text-[32px]">account_tree</span>
          </div>
          <div className="space-y-1.5">
            <h2 className="text-lg font-heading font-semibold text-[#e3e2e6]">
              No Supported Symbols Found
            </h2>
            <p className="text-xs text-[#938f98] leading-relaxed">
              This repository does not contain supported TypeScript/JavaScript symbols yet.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (!isLoading && error) {
    return (
      <div className="w-full h-full min-h-[600px] rounded-3xl border border-red-500/20 bg-[#121316] p-12 flex flex-col items-center justify-center text-center relative overflow-hidden select-none shadow-2xl">
        <div className="relative z-10 max-w-md space-y-4">
          <div className="w-16 h-16 rounded-2xl bg-red-500/10 border border-red-500/30 flex items-center justify-center text-red-400 mx-auto shadow-2xl">
            <span className="material-symbols-outlined text-[32px]">error</span>
          </div>
          <div className="space-y-1">
            <h2 className="text-base font-heading font-semibold text-[#e3e2e6]">
              Graph Analysis Unavailable
            </h2>
            <p className="text-xs text-red-300/80 leading-relaxed font-mono">{error}</p>
          </div>
          <button
            onClick={() => refetch()}
            className="px-5 py-2.5 bg-[#292a2d] hover:bg-[#343538] border border-[#48454d]/30 text-xs font-mono text-[#e3e2e6] rounded-xl transition-colors cursor-pointer shadow-lg"
          >
            Retry Analysis
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-full min-h-[600px] rounded-3xl border border-[#48454d]/35 bg-[#0b0c10] relative overflow-hidden shadow-2xl flex flex-col">
      {/* Top Floating Glass Command Bar */}
      <div className="absolute left-6 top-6 z-20 flex flex-wrap items-center gap-2.5">
        {/* Back Navigation Button */}
        <button
          onClick={handleBack}
          disabled={history.length === 0}
          className="px-3.5 py-2 rounded-xl bg-[#161820]/95 backdrop-blur-xl border border-[#48454d]/40 hover:border-[#fbcfe8]/60 text-[#cac5ce] hover:text-white disabled:opacity-30 disabled:hover:border-[#48454d]/40 disabled:hover:text-[#cac5ce] disabled:cursor-not-allowed transition-all shadow-md flex items-center gap-1.5 cursor-pointer text-xs font-mono select-none"
          title={history.length > 0 ? 'Back to last opened view' : 'No previous view'}
        >
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          <span>Back</span>
        </button>

        <GraphSearch
          nodes={apiData?.nodes || []}
          onSelectNode={handleSelectNodeById}
        />

        {/* 3-Tier Hierarchy Drilldown Level Selector */}
        <div className="flex items-center p-1 bg-[#161820]/95 backdrop-blur-xl border border-[#48454d]/40 rounded-xl shadow-md text-xs font-mono">
          <button
            onClick={() => handleSetViewLevel('purpose')}
            className={`px-3 py-1 rounded-lg transition-colors cursor-pointer flex items-center gap-1.5 ${
              hierarchyState.viewLevel === 'purpose'
                ? 'bg-[#fbcfe8]/20 text-[#fbcfe8] font-bold border border-[#fbcfe8]/40'
                : 'text-[#cac5ce] hover:text-white'
            }`}
            title="Overview of Purpose and Architecture Modules"
          >
            <span className="material-symbols-outlined text-[14px]">category</span>
            <span>1. Purpose</span>
          </button>

          <button
            onClick={() => handleSetViewLevel('classes')}
            className={`px-3 py-1 rounded-lg transition-colors cursor-pointer flex items-center gap-1.5 ${
              hierarchyState.viewLevel === 'classes'
                ? 'bg-[#fbcfe8]/20 text-[#fbcfe8] font-bold border border-[#fbcfe8]/40'
                : 'text-[#cac5ce] hover:text-white'
            }`}
            title="Expand into Classes, Interfaces & Enums"
          >
            <span className="material-symbols-outlined text-[14px]">view_in_ar</span>
            <span>2. Classes</span>
          </button>

          <button
            onClick={() => handleSetViewLevel('full')}
            className={`px-3 py-1 rounded-lg transition-colors cursor-pointer flex items-center gap-1.5 ${
              hierarchyState.viewLevel === 'full'
                ? 'bg-[#fbcfe8]/20 text-[#fbcfe8] font-bold border border-[#fbcfe8]/40'
                : 'text-[#cac5ce] hover:text-white'
            }`}
            title="Deep view with all member Functions and Calls"
          >
            <span className="material-symbols-outlined text-[14px]">code</span>
            <span>3. Functions</span>
          </button>
        </div>

        <GraphFilters
          filterState={filterState}
          onFilterChange={setFilterState}
          onResetFilters={handleResetFilters}
        />

        {/* Layout Direction Toggle */}
        <button
          onClick={() => setLayoutDirection((prev) => (prev === 'TB' ? 'LR' : 'TB'))}
          className="px-3.5 py-2 rounded-xl bg-[#161820]/95 backdrop-blur-xl border border-[#48454d]/40 hover:border-[#938f98]/80 text-[#cac5ce] hover:text-white transition-colors shadow-md flex items-center gap-1.5 cursor-pointer text-xs font-mono select-none"
          title={`Switch layout to ${layoutDirection === 'TB' ? 'Horizontal (LR)' : 'Vertical (TB)'}`}
        >
          <span className="material-symbols-outlined text-[16px]">
            {layoutDirection === 'TB' ? 'swap_vert' : 'swap_horiz'}
          </span>
          <span>{layoutDirection === 'TB' ? 'Vertical' : 'Horizontal'}</span>
        </button>

        {/* Fit View Quick Action */}
        <button
          onClick={() => reactFlowInstance.fitView({ padding: 0.18, duration: 400, maxZoom: 1.05 })}
          className="px-3 py-2 rounded-xl bg-[#161820]/95 backdrop-blur-xl border border-[#48454d]/40 hover:border-[#938f98]/80 text-[#cac5ce] hover:text-white transition-colors shadow-md flex items-center gap-1.5 cursor-pointer text-xs font-mono select-none"
          title="Fit view to graph"
        >
          <span className="material-symbols-outlined text-[16px]">center_focus_weak</span>
          <span>Fit</span>
        </button>

        <GraphLegend />

        {/* Focus Mode Banner / Reset Button */}
        {focusState.focusedNodeId && (
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-xl bg-[#70485c]/50 border border-[#fbcfe8]/70 text-[#fbcfe8] text-xs font-mono backdrop-blur-xl shadow-lg animate-in fade-in zoom-in-95">
            <span className="material-symbols-outlined text-[16px]">center_focus_strong</span>
            <span>Focus Mode Active</span>
            <button
              onClick={() => setFocusState(DEFAULT_FOCUS)}
              className="ml-1 text-[11px] font-bold underline hover:text-white cursor-pointer"
            >
              Clear Focus
            </button>
          </div>
        )}
      </div>

      {/* Top Right Live Stats & Actions */}
      <div className="absolute right-6 top-6 z-20 hidden md:flex items-center gap-2.5">
        {!selectedNodeId && (
          <div className="px-4 py-2 rounded-xl bg-[#161820]/95 backdrop-blur-xl border border-[#48454d]/40 text-xs font-mono text-[#938f98] shadow-lg flex items-center gap-2.5">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[#38bdf8] animate-pulse"></span>
              <strong className="text-white">{viewModel.displayedNodeCount}</strong> nodes
            </span>
            <span className="text-[#48454d]">•</span>
            <span>
              <strong className="text-white">{viewModel.edges.length}</strong> relationships
            </span>
          </div>
        )}
      </div>

      {/* Interactive Helper Banner */}
      <div className="absolute left-6 bottom-6 z-20 px-4 py-2.5 rounded-xl bg-[#161820]/95 backdrop-blur-xl border border-[#48454d]/40 text-xs font-mono text-[#938f98] shadow-2xl flex items-center gap-2 max-w-md">
        <span className="material-symbols-outlined text-[#fbcfe8] text-[16px]">touch_app</span>
        <span>
          Click any <strong>Purpose Node</strong> to expand classes/interfaces. Click any <strong>Class</strong> to unfold its functions.
        </span>
      </div>

      {/* Loading Overlay */}
      {isLoading && (
        <div className="absolute inset-0 z-30 bg-[#0b0c10]/85 backdrop-blur-md flex flex-col items-center justify-center space-y-4">
          <div className="w-10 h-10 rounded-full border-2 border-[#fbcfe8] border-t-transparent animate-spin"></div>
          <span className="text-xs font-mono text-[#b5b1ba] tracking-wider uppercase">
            Synthesizing Purpose-Driven Architecture Graph...
          </span>
        </div>
      )}

      {/* React Flow Canvas */}
      <div className="flex-1 w-full h-full">
        <ReactFlow
          nodes={viewModel.nodes}
          edges={viewModel.edges}
          nodeTypes={nodeTypes}
          onNodeClick={handleNodeClick}
          onPaneClick={() => setSelectedNodeId(null)}
          fitView
          minZoom={0.2}
          maxZoom={2.5}
          defaultEdgeOptions={{ type: 'smoothstep' }}
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={32}
            size={1.8}
            color="#48454d"
            className="opacity-35"
          />
          <Controls position="bottom-right" className="!m-6" showInteractive={false} />
          <MiniMap
            position="bottom-left"
            className="!m-6 !hidden lg:!block !rounded-2xl !overflow-hidden !border !border-[#48454d]/40 !shadow-2xl"
            nodeColor={(n) => {
              if (n.type === 'purposeNode') return '#fbcfe8';
              const symType = (n.data as any)?.type;
              if (symType === 'class') return '#3b82f6';
              if (symType === 'interface') return '#10b981';
              if (symType === 'function') return '#f59e0b';
              if (symType === 'method') return '#06b6d4';
              if (symType === 'constructor') return '#8b5cf6';
              return '#6b7280';
            }}
            maskColor="rgba(11, 12, 16, 0.88)"
          />
        </ReactFlow>
      </div>

      {/* Node Details Slide-in Panel */}
      <SymbolDetailsPanel
        selectedNode={selectedNodeData}
        allNodes={apiData?.nodes || []}
        allEdges={apiData?.edges || []}
        isFocused={focusState.focusedNodeId === selectedNodeId}
        onClose={() => setSelectedNodeId(null)}
        onSelectNode={handleSelectNodeById}
        onToggleFocus={handleToggleFocus}
        onExpandNode={handleExpandNode}
        onSelectFile={onSelectFile}
        onAskAi={onAskAi}
        repoName={repo.name}
      />
    </div>
  );
}

export const DependencyGraphView: React.FC<DependencyGraphViewProps> = (props) => {
  return (
    <ReactFlowProvider>
      <InnerNodalGraphView {...props} />
    </ReactFlowProvider>
  );
};
