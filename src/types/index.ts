export type TabType = 'summary' | 'graph' | 'files' | 'analysis' | 'dashboard' | 'chat' | 'settings';

export interface FileCitation {
  filename: string;
  path: string;
  language: string;
  snippet?: string;
  lineRange?: string;
  startLine?: number;
  endLine?: number;
}

export interface ChatMessage {
  id: string;
  sender: 'user' | 'assistant';
  content: string;
  timestamp: string;
  citations?: FileCitation[];
  confidenceScore?: number;
  isStreaming?: boolean;
  implementationPlan?: {
    step: number;
    title: string;
    targetFile: string;
  }[];
}

export interface Technology {
  name: string;
  category: 'language' | 'framework' | 'adapter' | 'database' | 'caching' | 'auth' | 'build' | 'container' | 'tools';
  icon?: string;
  color?: string;
}

export interface RepositoryStats {
  classes: number;
  packages: number;
  files: number;
  endpoints: number;
  dependencies: number;
  functions: number;
}

export interface ArchitectureFlowReference {
  filePath: string;
  symbolName?: string;
  symbolType?: string;
  startLine?: number;
  endLine?: number;
}

export interface ArchitectureFlowNode {
  id: string;
  label: string;
  type: 'entry' | 'controller' | 'route' | 'service' | 'module' | 'repository' | 'entity' | 'database' | 'cache' | 'config' | string;
  description?: string;
  icon?: string;
  color?: string;
  files: string[];
  symbols: string[];
  references: ArchitectureFlowReference[];
}

export interface ArchitectureFlow {
  nodes: ArchitectureFlowNode[];
}

export interface RepositorySummary {
  projectType: string;
  architecture: string;
  backend: string;
  httpAdapter?: string;
  frontend: string;
  authentication: string;
  database: string;
  caching?: string;
  buildTool?: string;
  description: string;
  keyPackages: string[];
  architectureFlow?: ArchitectureFlow;
}

export interface GraphNode {
  id: string;
  label: string;
  category: 'controller' | 'service' | 'repository' | 'database';
  icon: string;
  x: number;
  y: number;
  file?: string;
  details: string;
  methods?: string[];
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  type: 'calls' | 'uses' | 'accesses' | 'queries';
}

export interface FileTreeNode {
  id: string;
  name: string;
  path: string;
  type: 'folder' | 'file';
  isOpen?: boolean;
  children?: FileTreeNode[];
  content?: string;
  language?: string;
}

export interface Repository {
  id: string;
  name: string;
  fullName: string;
  url?: string;
  size?: string;
  primaryLanguage: string;
  framework: string;
  fileCount: number;
  folderCount: number;
  estimatedTokens: number;
  branch: string;
  userId?: string;
  commitCount?: number;
  status: 'PENDING' | 'DOWNLOADING' | 'EXTRACTING' | 'SCANNING' | 'PARSING' | 'CHUNKING' | 'EMBEDDING' | 'COMPLETED' | 'FAILED' | 'indexed' | 'indexing' | 'error';
  stage?: string;
  progress?: number;
  lastIndexedAt?: string;
  createdAt?: string;
  lastOpenedAt?: string | null;
  stats?: RepositoryStats;
  technologies: Technology[];
  summary: RepositorySummary;
  sampleQuestions?: string[];
  errorMessage?: string;
  graphNodes?: GraphNode[];
  graphEdges?: GraphEdge[];
  fileTree?: FileTreeNode;
}

export type IndexingStage =
  | 'uploading'
  | 'extracting'
  | 'reading'
  | 'chunking'
  | 'embeddings'
  | 'saving'
  | 'completed';

export interface IndexingStepStatus {
  id: IndexingStage;
  label: string;
  detail: string;
  progress: number;
  status: 'pending' | 'in_progress' | 'completed';
}

// AI Feature Planner Types
export interface FeaturePlanArchitectureItem {
  symbol: string;
  filePath: string;
  reason: string;
}

export interface FeaturePlanFileToModify {
  filePath: string;
  symbols: string[];
  reason: string;
  existingReference?: string;
}

export interface FeaturePlanFileToCreate {
  filePath: string;
  purpose: string;
}

export interface FeaturePlanDependency {
  name: string;
  reason: string;
}

export interface FeaturePlanApiChange {
  endpoint: string;
  type: 'NEW ENDPOINT' | 'MODIFIED ENDPOINT' | string;
  description: string;
}

export interface FeaturePlanStep {
  step: number;
  title: string;
  description: string;
  files: string[];
  symbols: string[];
}

export interface FeaturePlanEvidence {
  files: string[];
  symbols: string[];
  chunkCount: number;
}

export interface FeaturePlanData {
  overview: string;
  relevantArchitecture: FeaturePlanArchitectureItem[];
  filesToModify: FeaturePlanFileToModify[];
  filesToCreate: FeaturePlanFileToCreate[];
  dependencies: FeaturePlanDependency[];
  databaseChanges: string[];
  apiChanges: FeaturePlanApiChange[];
  implementationSteps: FeaturePlanStep[];
  potentialSideEffects: string[];
  evidence: FeaturePlanEvidence;
}

export interface FeaturePlanRecord {
  id: string;
  repositoryId: string;
  userId?: string;
  featureRequest: string;
  planJson: FeaturePlanData;
  status: string;
  createdAt: string;
  updatedAt: string;
}

// Phase 3 AI Code Change Generation Types
export type ChangesetStatus = 'generating' | 'ready' | 'approved' | 'rejected';

export interface GeneratedFileChange {
  id: string;
  changesetId: string;
  filePath: string;
  changeType: 'modify' | 'create' | 'delete';
  reason: string;
  originalContent?: string | null;
  proposedContent: string;
  affectedSymbols: string[];
  createdAt: string;
}

export interface GeneratedChangeset {
  id: string;
  featurePlanId: string;
  repositoryId: string;
  userId?: string;
  version: number;
  parentChangesetId?: string | null;
  status: ChangesetStatus;
  summary: string;
  changes: GeneratedFileChange[];
  additionalRequiredChanges?: string[];
  warnings?: string[];
  createdAt: string;
  updatedAt: string;
}

// Phase 3 Part 2: Generated Code Validation & Testing Types
export type ValidationStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'error';
export type ValidationCheckType = 'typecheck' | 'build' | 'test';

export interface ValidationError {
  filePath?: string;
  line?: number;
  column?: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface ValidationCheck {
  type: ValidationCheckType;
  name: string;
  status: ValidationStatus;
  command?: string;
  exitCode?: number;
  durationMs?: number;
  output?: string;
  errorCount?: number;
  message?: string;
  errors?: ValidationError[];
}

export interface ValidationResult {
  id: string;
  changesetId: string;
  repositoryId: string;
  userId?: string;
  status: ValidationStatus;
  overallStatus?: ValidationStatus;
  summary?: string;
  checks: ValidationCheck[];
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}

// Phase 4.0: GitHub Account Connection Types
export interface GitHubConnectionStatus {
  connected: boolean;
  githubLogin?: string;
  avatarUrl?: string;
  connectedAt?: string;
}

// Phase 4.1 & 4.2: GitHub Branch & Commit Types
export interface ChangesetBranch {
  id: string;
  changesetId: string;
  repositoryId: string;
  userId?: string;
  githubRepoOwner: string;
  githubRepoName: string;
  branchName: string;
  baseBranch: string;
  baseSha: string;
  stagedTreeSha?: string;
  commitSha?: string;
  commitMessage?: string;
  committedAt?: string;
  status: 'created' | 'staged' | 'committed' | 'pr_created';
  fileCount: number;
  htmlUrl?: string;
  commitUrl?: string;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

// Phase 4.3: GitHub Pull Request Types
export interface PullRequestRecord {
  id: string;
  changesetId: string;
  repositoryId: string;
  userId?: string;
  githubRepoOwner: string;
  githubRepoName: string;
  githubPrNumber: number;
  githubPrUrl: string;
  githubPrApiUrl?: string;
  branchName: string;
  baseBranch: string;
  commitSha: string;
  title: string;
  body?: string;
  status: 'open' | 'closed' | 'merged';
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}
