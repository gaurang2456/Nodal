import dagre from '@dagrejs/dagre';
import { Node, Edge, MarkerType } from '@xyflow/react';
import { SymbolType, RelationshipType, ConfidenceLevel } from '@/server/analyzer/types';

export interface GraphApiNode {
  id: string;
  name: string;
  type: SymbolType;
  filePath: string;
  startLine: number;
  endLine: number;
  exported: boolean;
}

export interface GraphApiEdge {
  id: string;
  source: string;
  target: string;
  type: RelationshipType;
  confidence: ConfidenceLevel;
}

export interface GraphApiResponse {
  nodes: GraphApiNode[];
  edges: GraphApiEdge[];
  stats?: {
    symbolCount: number;
    relationshipCount: number;
  };
}

export interface PurposeCluster {
  id: string; // e.g. "purpose:auth"
  purposeId: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  folderPath: string;
  classesCount: number;
  interfacesCount: number;
  functionsCount: number;
  enumsCount: number;
  totalSymbols: number;
  symbolIds: string[];
}

export interface SymbolNodeData extends Record<string, unknown> {
  id: string;
  name: string;
  type: SymbolType;
  filePath: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  isSelected?: boolean;
  isFocused?: boolean;
  incomingCount?: number;
  outgoingCount?: number;
  isExpanded?: boolean;
  memberMethodCount?: number;
  isUnfolded?: boolean;
  moduleGroup?: string;
  parentClassId?: string;
  parentPurposeId?: string;
  onToggleUnfold?: (nodeId: string) => void;
}

export type SymbolNodeType = Node<SymbolNodeData, 'symbolNode'>;

export interface GraphHierarchyState {
  expandedPurposeIds: Set<string>;
  unfoldedNodeIds: Set<string>;
  viewLevel: 'purpose' | 'classes' | 'full';
  groupingMode?: 'modules' | 'flat';
}

export interface GraphFilterState {
  nodeTypes: Set<SymbolType>;
  relationshipTypes: Set<RelationshipType>;
  includeMediumConfidence: boolean;
  includeMethods: boolean;
  maxInitialNodes: number;
}

export interface GraphFocusState {
  focusedNodeId: string | null;
  expandedNodeIds: Set<string>;
}

export const DEFAULT_NODE_TYPES: SymbolType[] = [
  'class',
  'interface',
  'function',
  'enum',
  'variable',
];

export const ALL_RELATIONSHIP_TYPES: RelationshipType[] = [
  'INJECTS',
  'CALLS',
  'EXTENDS',
  'IMPLEMENTS',
  'USES',
  'IMPORTS',
];

export const RELATIONSHIP_META: Record<
  RelationshipType,
  { label: string; color: string; strokeDasharray?: string; description: string }
> = {
  INJECTS: {
    label: 'INJECTS',
    color: '#f472b6', // Pink
    description: 'Dependency injection via constructor or @Inject',
  },
  CALLS: {
    label: 'CALLS',
    color: '#38bdf8', // Sky Blue
    description: 'Method or function invocation',
  },
  EXTENDS: {
    label: 'EXTENDS',
    color: '#c084fc', // Purple
    description: 'Class or interface inheritance',
  },
  IMPLEMENTS: {
    label: 'IMPLEMENTS',
    color: '#34d399', // Emerald
    strokeDasharray: '5,5',
    description: 'Interface implementation',
  },
  USES: {
    label: 'USES',
    color: '#818cf8', // Indigo
    description: 'Property or local dependency usage',
  },
  IMPORTS: {
    label: 'IMPORTS',
    color: '#94a3b8', // Slate
    strokeDasharray: '4,4',
    description: 'Module or symbol import',
  },
};

export const SYMBOL_META: Record<
  SymbolType,
  { label: string; icon: string; bg: string; text: string; border: string }
> = {
  class: {
    label: 'Class',
    icon: 'view_in_ar',
    bg: 'bg-blue-500/10',
    text: 'text-blue-400',
    border: 'border-blue-500/30',
  },
  interface: {
    label: 'Interface',
    icon: 'data_object',
    bg: 'bg-emerald-500/10',
    text: 'text-emerald-400',
    border: 'border-emerald-500/30',
  },
  function: {
    label: 'Function',
    icon: 'code',
    bg: 'bg-amber-500/10',
    text: 'text-amber-400',
    border: 'border-amber-500/30',
  },
  method: {
    label: 'Method',
    icon: 'play_circle',
    bg: 'bg-cyan-500/10',
    text: 'text-cyan-400',
    border: 'border-cyan-500/30',
  },
  constructor: {
    label: 'Constructor',
    icon: 'build',
    bg: 'bg-violet-500/10',
    text: 'text-violet-400',
    border: 'border-violet-500/30',
  },
  enum: {
    label: 'Enum',
    icon: 'list',
    bg: 'bg-purple-500/10',
    text: 'text-purple-400',
    border: 'border-purple-500/30',
  },
  variable: {
    label: 'Variable',
    icon: 'tune',
    bg: 'bg-zinc-500/10',
    text: 'text-zinc-400',
    border: 'border-zinc-500/30',
  },
};

const NODE_WIDTH = 310;
const NODE_HEIGHT = 110;
const PURPOSE_NODE_WIDTH = 340;
const PURPOSE_NODE_HEIGHT = 170;
export const MAX_VISIBLE_NODES = 50;

// Structural position cache: structuralKey -> Map<nodeId, { x, y }>
const layoutPositionCache = new Map<string, Map<string, { x: number; y: number }>>();
let layoutExecutionCount = 0;

export function extractModuleGroup(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (parts.length <= 1) return 'root';
  if (parts[0] === 'src' && parts.length > 2) {
    return parts[1]; // e.g. src/auth/service.ts -> auth
  }
  return parts[0];
}

/**
 * Heuristically clusters repository symbols into Purpose / Feature architecture modules.
 */
export function clusterPurposeModules(nodes: GraphApiNode[]): PurposeCluster[] {
  const groups = new Map<string, GraphApiNode[]>();

  for (const node of nodes) {
    const rawModule = extractModuleGroup(node.filePath).toLowerCase();
    let clusterKey = rawModule;

    // Detect architectural purpose heuristics
    if (rawModule.includes('auth') || rawModule.includes('security') || rawModule.includes('jwt')) {
      clusterKey = 'auth';
    } else if (rawModule.includes('user') || rawModule.includes('account') || rawModule.includes('profile')) {
      clusterKey = 'users';
    } else if (rawModule.includes('controller') || rawModule.includes('api') || rawModule.includes('route')) {
      clusterKey = 'api';
    } else if (rawModule.includes('service') || rawModule.includes('domain') || rawModule.includes('core')) {
      clusterKey = 'services';
    } else if (
      rawModule.includes('repo') ||
      rawModule.includes('data') ||
      rawModule.includes('db') ||
      rawModule.includes('prisma') ||
      rawModule.includes('entity')
    ) {
      clusterKey = 'database';
    } else if (rawModule.includes('util') || rawModule.includes('helper') || rawModule.includes('common')) {
      clusterKey = 'utils';
    }

    if (!groups.has(clusterKey)) {
      groups.set(clusterKey, []);
    }
    groups.get(clusterKey)!.push(node);
  }

  const clusters: PurposeCluster[] = [];

  const PURPOSE_DESCRIPTIONS: Record<
    string,
    { name: string; description: string; icon: string; color: string }
  > = {
    auth: {
      name: 'Auth & Security',
      description: 'Authentication, authorization, tokens, and identity verification.',
      icon: 'security',
      color: '#f472b6',
    },
    users: {
      name: 'User Management',
      description: 'User profiles, account state, and membership handling.',
      icon: 'group',
      color: '#38bdf8',
    },
    api: {
      name: 'API & Ingress',
      description: 'HTTP routing, REST controllers, endpoints, and request handling.',
      icon: 'hub',
      color: '#c084fc',
    },
    services: {
      name: 'Business Services',
      description: 'Core domain business logic, workflows, and service orchestration.',
      icon: 'layers',
      color: '#34d399',
    },
    database: {
      name: 'Data & Persistence',
      description: 'Repositories, database schemas, entities, and storage operations.',
      icon: 'database',
      color: '#10b981',
    },
    utils: {
      name: 'Shared Utilities',
      description: 'Helper utilities, formatting, shared configs, and constants.',
      icon: 'build',
      color: '#f59e0b',
    },
  };

  for (const [key, clusterNodes] of groups.entries()) {
    const meta = PURPOSE_DESCRIPTIONS[key] || {
      name: `${key.charAt(0).toUpperCase() + key.slice(1)} Module`,
      description: `Symbols and logic located under ${key} directory.`,
      icon: 'folder',
      color: '#93c5fd',
    };

    const classesCount = clusterNodes.filter((n) => n.type === 'class').length;
    const interfacesCount = clusterNodes.filter((n) => n.type === 'interface').length;
    const functionsCount = clusterNodes.filter((n) => n.type === 'function').length;
    const enumsCount = clusterNodes.filter((n) => n.type === 'enum').length;

    // Sample folder path
    const samplePath = clusterNodes[0]?.filePath ? extractModuleGroup(clusterNodes[0].filePath) : key;

    clusters.push({
      id: `purpose:${key}`,
      purposeId: key,
      name: meta.name,
      description: meta.description,
      icon: meta.icon,
      color: meta.color,
      folderPath: `src/${samplePath}`,
      classesCount,
      interfacesCount,
      functionsCount,
      enumsCount,
      totalSymbols: clusterNodes.length,
      symbolIds: clusterNodes.map((n) => n.id),
    });
  }

  // Sort clusters: Auth -> API -> Services -> Users -> Database -> Utils -> others
  const orderWeight: Record<string, number> = {
    auth: 1,
    api: 2,
    services: 3,
    users: 4,
    database: 5,
    utils: 6,
  };

  clusters.sort((a, b) => (orderWeight[a.purposeId] || 99) - (orderWeight[b.purposeId] || 99));

  return clusters;
}

/**
 * Transforms raw API graph data into a 3-Tier Progressive Drilldown React Flow View Model:
 * Tier 1: Purpose Nodes (Overview)
 * Tier 2: Contained Classes, Interfaces, Enums (on Purpose Expand)
 * Tier 3: Contained Member Methods & Functions (on Class Expand)
 */
export function buildGraphViewModel(
  apiData: GraphApiResponse,
  filterState: GraphFilterState,
  focusState: GraphFocusState,
  selectedNodeId: string | null,
  layoutDirection: 'TB' | 'LR' = 'TB',
  hierarchyState?: GraphHierarchyState,
  onToggleUnfold?: (nodeId: string) => void,
  onTogglePurposeExpand?: (purposeId: string) => void
): {
  nodes: Node[];
  edges: Edge[];
  totalAvailableNodes: number;
  displayedNodeCount: number;
  isLimited: boolean;
  purposeClusters: PurposeCluster[];
} {
  const { nodes: rawNodes, edges: rawEdges } = apiData;
  const totalAvailableNodes = rawNodes.length;

  if (totalAvailableNodes === 0) {
    return {
      nodes: [],
      edges: [],
      totalAvailableNodes: 0,
      displayedNodeCount: 0,
      isLimited: false,
      purposeClusters: [],
    };
  }

  const clusters = clusterPurposeModules(rawNodes);
  const clusterByNodeId = new Map<string, PurposeCluster>();
  for (const cluster of clusters) {
    for (const symId of cluster.symbolIds) {
      clusterByNodeId.set(symId, cluster);
    }
  }

  // Map methods to parent classes
  const methodsByParentClass = new Map<string, GraphApiNode[]>();
  const classIdSet = new Set(rawNodes.filter((n) => n.type === 'class').map((n) => n.id));

  for (const node of rawNodes) {
    if (node.type === 'method' || node.type === 'constructor') {
      const lastDotIndex = node.id.lastIndexOf('.');
      if (lastDotIndex !== -1) {
        const parentClassId = node.id.substring(0, lastDotIndex);
        if (classIdSet.has(parentClassId)) {
          if (!methodsByParentClass.has(parentClassId)) {
            methodsByParentClass.set(parentClassId, []);
          }
          methodsByParentClass.get(parentClassId)!.push(node);
        }
      }
    }
  }

  const expandedPurposeIds = hierarchyState?.expandedPurposeIds || new Set<string>();
  const unfoldedClassIds = hierarchyState?.unfoldedNodeIds || new Set<string>();
  const viewLevel = hierarchyState?.viewLevel || 'purpose';

  const rfNodes: Node[] = [];
  const rfEdges: Edge[] = [];

  // Track symbol degrees
  const incomingMap = new Map<string, number>();
  const outgoingMap = new Map<string, number>();
  for (const edge of rawEdges) {
    outgoingMap.set(edge.source, (outgoingMap.get(edge.source) || 0) + 1);
    incomingMap.set(edge.target, (incomingMap.get(edge.target) || 0) + 1);
  }

  // Determine if in Focus Mode
  const isFocusMode = Boolean(focusState.focusedNodeId);

  if (isFocusMode) {
    // Focus Mode: Show focused symbol and direct neighbors without hiding behind purpose nodes
    const activeFocusSet = new Set<string>([focusState.focusedNodeId!, ...focusState.expandedNodeIds]);
    const neighborSet = new Set<string>(activeFocusSet);

    for (const edge of rawEdges) {
      if (activeFocusSet.has(edge.source)) neighborSet.add(edge.target);
      if (activeFocusSet.has(edge.target)) neighborSet.add(edge.source);
    }

    const focusNodes = rawNodes.filter((n) => neighborSet.has(n.id));
    for (const node of focusNodes) {
      const isSelected = selectedNodeId === node.id;
      const isFocused = focusState.focusedNodeId === node.id;
      const memberMethods = methodsByParentClass.get(node.id) || [];
      const isUnfolded = unfoldedClassIds.has(node.id);
      const cluster = clusterByNodeId.get(node.id);

      rfNodes.push({
        id: node.id,
        type: 'symbolNode',
        position: { x: 0, y: 0 },
        data: {
          id: node.id,
          name: node.name,
          type: node.type,
          filePath: node.filePath,
          startLine: node.startLine,
          endLine: node.endLine,
          exported: node.exported,
          isSelected,
          isFocused,
          incomingCount: incomingMap.get(node.id) || 0,
          outgoingCount: outgoingMap.get(node.id) || 0,
          memberMethodCount: memberMethods.length,
          isUnfolded,
          moduleGroup: cluster?.name || extractModuleGroup(node.filePath),
          onToggleUnfold,
        } as SymbolNodeData,
      });
    }

    const focusNodeIdSet = new Set(focusNodes.map((n) => n.id));
    const focusEdges = rawEdges.filter(
      (e) => focusNodeIdSet.has(e.source) && focusNodeIdSet.has(e.target)
    );

    for (const edge of focusEdges) {
      const meta = RELATIONSHIP_META[edge.type] || { label: edge.type, color: '#938f98' };
      rfEdges.push({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        animated: edge.type === 'INJECTS' || edge.type === 'CALLS',
        style: { stroke: meta.color, strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: meta.color, width: 15, height: 15 },
        data: { type: edge.type, confidence: edge.confidence },
      });
    }
  } else {
    // 3-Tier Progressive Hierarchy Mode
    // A. Render Tier 1 Purpose Nodes
    for (const cluster of clusters) {
      const isExpanded =
        viewLevel === 'classes' ||
        viewLevel === 'full' ||
        expandedPurposeIds.has(cluster.purposeId);

      rfNodes.push({
        id: cluster.id,
        type: 'purposeNode',
        position: { x: 0, y: 0 },
        data: {
          id: cluster.id,
          purposeId: cluster.purposeId,
          name: cluster.name,
          description: cluster.description,
          icon: cluster.icon,
          color: cluster.color,
          folderPath: cluster.folderPath,
          classesCount: cluster.classesCount,
          interfacesCount: cluster.interfacesCount,
          functionsCount: cluster.functionsCount,
          enumsCount: cluster.enumsCount,
          totalSymbols: cluster.totalSymbols,
          isExpanded,
          onToggleExpand: onTogglePurposeExpand,
        },
      });

      // B. If Purpose Node is expanded -> Render Tier 2 Contained Key Symbols (Classes first, max 8 per cluster)
      if (isExpanded) {
        const clusterSymbols = rawNodes
          .filter(
            (n) => cluster.symbolIds.includes(n.id) && (n.type !== 'method' && n.type !== 'constructor')
          )
          .sort((a, b) => {
            const typeRank: Record<string, number> = { class: 1, interface: 2, function: 3, enum: 4, variable: 5 };
            const rankDiff = (typeRank[a.type] || 99) - (typeRank[b.type] || 99);
            if (rankDiff !== 0) return rankDiff;
            const degA = (incomingMap.get(a.id) || 0) + (outgoingMap.get(a.id) || 0);
            const degB = (incomingMap.get(b.id) || 0) + (outgoingMap.get(b.id) || 0);
            return degB - degA;
          })
          .slice(0, 8); // Strictly cap at top 8 key symbols per module

        for (const sym of clusterSymbols) {
          if (rfNodes.length >= MAX_VISIBLE_NODES) break;

          const isSelected = selectedNodeId === sym.id;
          const memberMethods = methodsByParentClass.get(sym.id) || [];
          const isClassUnfolded =
            viewLevel === 'full' || unfoldedClassIds.has(sym.id) || filterState.includeMethods;

          rfNodes.push({
            id: sym.id,
            type: 'symbolNode',
            position: { x: 0, y: 0 },
            data: {
              id: sym.id,
              name: sym.name,
              type: sym.type,
              filePath: sym.filePath,
              startLine: sym.startLine,
              endLine: sym.endLine,
              exported: sym.exported,
              isSelected,
              incomingCount: incomingMap.get(sym.id) || 0,
              outgoingCount: outgoingMap.get(sym.id) || 0,
              memberMethodCount: memberMethods.length,
              isUnfolded: isClassUnfolded,
              moduleGroup: cluster.name,
              parentPurposeId: cluster.id,
              onToggleUnfold,
            } as SymbolNodeData,
          });

          // Edge from Purpose Node -> Contained Class
          rfEdges.push({
            id: `purpose-contains-${cluster.id}-${sym.id}`,
            source: cluster.id,
            target: sym.id,
            type: 'smoothstep',
            animated: true,
            style: {
              stroke: `${cluster.color}90`,
              strokeWidth: 1.5,
              strokeDasharray: '4,4',
            },
            markerEnd: {
              type: MarkerType.ArrowClosed,
              color: cluster.color,
              width: 12,
              height: 12,
            },
            data: { type: 'USES' as RelationshipType, confidence: 'high' as ConfidenceLevel },
          });

          // C. If Class is expanded -> Render Tier 3 Member Functions/Methods (max 6 methods per class)
          if (isClassUnfolded && memberMethods.length > 0) {
            for (const method of memberMethods.slice(0, 6)) {
              if (rfNodes.length >= MAX_VISIBLE_NODES) break;

              rfNodes.push({
                id: method.id,
                type: 'symbolNode',
                position: { x: 0, y: 0 },
                data: {
                  id: method.id,
                  name: method.name,
                  type: method.type,
                  filePath: method.filePath,
                  startLine: method.startLine,
                  endLine: method.endLine,
                  exported: method.exported,
                  isSelected: selectedNodeId === method.id,
                  moduleGroup: cluster.name,
                  parentClassId: sym.id,
                } as SymbolNodeData,
              });

              // Edge from Class -> Method
              rfEdges.push({
                id: `class-method-${sym.id}-${method.id}`,
                source: sym.id,
                target: method.id,
                type: 'smoothstep',
                animated: true,
                style: {
                  stroke: '#06b6d4',
                  strokeWidth: 1.5,
                  strokeDasharray: '3,3',
                },
                markerEnd: {
                  type: MarkerType.ArrowClosed,
                  color: '#06b6d4',
                  width: 12,
                  height: 12,
                },
                data: { type: 'CALLS' as RelationshipType, confidence: 'high' as ConfidenceLevel },
              });
            }
          }
        }
      }
    }

    const currentVisibleIdSet = new Set(rfNodes.map((n) => n.id));

    // Connect raw cross-symbol edges if both source & target symbols are visible
    for (const edge of rawEdges) {
      if (currentVisibleIdSet.has(edge.source) && currentVisibleIdSet.has(edge.target)) {
        const meta = RELATIONSHIP_META[edge.type] || { label: edge.type, color: '#938f98' };
        rfEdges.push({
          id: `sym-rel-${edge.id}`,
          source: edge.source,
          target: edge.target,
          animated: edge.type === 'INJECTS' || edge.type === 'CALLS',
          style: { stroke: meta.color, strokeWidth: 1.75, strokeDasharray: meta.strokeDasharray },
          markerEnd: { type: MarkerType.ArrowClosed, color: meta.color, width: 14, height: 14 },
          data: { type: edge.type, confidence: edge.confidence },
        });
      }
    }

    // Connect Purpose-to-Purpose high-level edges if symbols inside cluster A connect to symbols in cluster B
    const clusterPairs = new Set<string>();
    for (const edge of rawEdges) {
      const srcCluster = clusterByNodeId.get(edge.source);
      const tgtCluster = clusterByNodeId.get(edge.target);

      if (srcCluster && tgtCluster && srcCluster.id !== tgtCluster.id) {
        const pairKey = `${srcCluster.id}->${tgtCluster.id}`;
        if (!clusterPairs.has(pairKey)) {
          clusterPairs.add(pairKey);

          // Only add purpose flow edge if both purpose nodes are visible
          if (currentVisibleIdSet.has(srcCluster.id) && currentVisibleIdSet.has(tgtCluster.id)) {
            rfEdges.push({
              id: `purpose-flow-${pairKey}`,
              source: srcCluster.id,
              target: tgtCluster.id,
              type: 'smoothstep',
              animated: true,
              style: {
                stroke: '#fbcfe8',
                strokeWidth: 2.25,
              },
              markerEnd: {
                type: MarkerType.ArrowClosed,
                color: '#fbcfe8',
                width: 16,
                height: 16,
              },
              data: { type: edge.type, confidence: 'high' as ConfidenceLevel },
            });
          }
        }
      }
    }
  }

  // Layout all visible nodes with Dagre (cached by structural key)
  const layoutedNodes = applyDagreLayout(rfNodes, rfEdges, layoutDirection);

  console.log(
    `[Nodal Telemetry] Total API: ${totalAvailableNodes} nodes, ${rawEdges.length} edges | Visible: ${rfNodes.length} nodes, ${rfEdges.length} edges`
  );

  return {
    nodes: layoutedNodes,
    edges: rfEdges,
    totalAvailableNodes,
    displayedNodeCount: rfNodes.length,
    isLimited: false,
    purposeClusters: clusters,
  };
}

/**
 * Applies Dagre hierarchical automatic layout to React Flow nodes with structural position caching.
 */
export function applyDagreLayout(
  nodes: Node[],
  edges: Edge[],
  direction: 'TB' | 'LR' = 'TB'
): Node[] {
  if (nodes.length === 0) return [];

  // Generate unique structural signature
  const nodeKey = nodes.map((n) => n.id).sort().join('|');
  const edgeKey = edges.map((e) => `${e.source}->${e.target}`).sort().join('|');
  const structuralKey = `${direction}::${nodeKey}::${edgeKey}`;

  let positions = layoutPositionCache.get(structuralKey);

  if (!positions) {
    layoutExecutionCount++;
    const t0 = performance.now();

    const g = new dagre.graphlib.Graph();
    g.setGraph({
      rankdir: direction,
      nodesep: 80,
      ranksep: 120,
      marginx: 50,
      marginy: 50,
    });
    g.setDefaultEdgeLabel(() => ({}));

    nodes.forEach((node) => {
      const isPurpose = node.type === 'purposeNode';
      const width = isPurpose ? PURPOSE_NODE_WIDTH : NODE_WIDTH;
      const height = isPurpose ? PURPOSE_NODE_HEIGHT : NODE_HEIGHT;
      g.setNode(node.id, { width, height });
    });

    edges.forEach((edge) => {
      g.setEdge(edge.source, edge.target);
    });

    dagre.layout(g);

    positions = new Map<string, { x: number; y: number }>();
    nodes.forEach((node) => {
      const nodeWithPos = g.node(node.id);
      if (nodeWithPos) {
        const isPurpose = node.type === 'purposeNode';
        const width = isPurpose ? PURPOSE_NODE_WIDTH : NODE_WIDTH;
        const height = isPurpose ? PURPOSE_NODE_HEIGHT : NODE_HEIGHT;
        positions!.set(node.id, {
          x: nodeWithPos.x - width / 2,
          y: nodeWithPos.y - height / 2,
        });
      }
    });

    // Cache position map (evict old entries if too large)
    if (layoutPositionCache.size > 30) {
      const firstKey = layoutPositionCache.keys().next().value;
      if (firstKey) layoutPositionCache.delete(firstKey);
    }
    layoutPositionCache.set(structuralKey, positions);

    const t1 = performance.now();
    console.log(
      `[Nodal Perf] Layout #${layoutExecutionCount} computed for ${nodes.length} nodes, ${edges.length} edges in ${(t1 - t0).toFixed(1)}ms`
    );
  }

  return nodes.map((node) => {
    const pos = positions!.get(node.id) || { x: 0, y: 0 };
    return {
      ...node,
      position: pos,
    };
  });
}
