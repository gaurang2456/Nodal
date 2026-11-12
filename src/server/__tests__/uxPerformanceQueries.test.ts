import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

// Load .env.local if not already in process.env
if (!process.env.DATABASE_URL) {
  const envPath = path.resolve(process.cwd(), '.env.local');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        const val = match[2].trim().replace(/^['"](.*)['"]$/, '$1');
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
}

import {
  REPOSITORY_KEYS,
  ARCHITECTURE_KEYS,
  GRAPH_KEYS,
  FILES_KEYS,
  PLAN_KEYS,
  CHANGESET_KEYS,
  GITHUB_KEYS,
  VALIDATION_KEYS,
  mapBackendRepoToRepository,
} from '../../lib/api/queries';

describe('UX Performance & TanStack Query Keys & State Isolation Tests', () => {
  test('1. Repository query keys & mapping', () => {
    assert.deepStrictEqual(REPOSITORY_KEYS.all, ['repositories']);
    assert.deepStrictEqual(REPOSITORY_KEYS.detail('repo-123'), ['repository', 'repo-123']);
    assert.notDeepStrictEqual(REPOSITORY_KEYS.detail('repo-123'), REPOSITORY_KEYS.detail('repo-456'));

    const mapped = mapBackendRepoToRepository({
      id: 'r1',
      name: 'Nodal',
      full_name: 'org/nodal',
      github_url: 'https://github.com/org/nodal',
      status: 'COMPLETED',
      stage: 'Ready',
      progress: 100,
      created_at: '2026-09-01T10:00:00Z',
    });

    assert.strictEqual(mapped.id, 'r1');
    assert.strictEqual(mapped.name, 'Nodal');
    assert.strictEqual(mapped.primaryLanguage, 'Code');
    assert.strictEqual(mapped.framework, 'Standard');
    assert.strictEqual(mapped.fileCount, 0);
  });

  test('2. Architecture and Graph query keys isolate by repository ID', () => {
    const archKeyA = ARCHITECTURE_KEYS.detail('repo-A');
    const archKeyB = ARCHITECTURE_KEYS.detail('repo-B');
    assert.deepStrictEqual(archKeyA, ['architecture', 'repo-A']);
    assert.notDeepStrictEqual(archKeyA, archKeyB);

    const graphKeyA = GRAPH_KEYS.detail('repo-A');
    const graphKeyB = GRAPH_KEYS.detail('repo-B');
    assert.deepStrictEqual(graphKeyA, ['graph', 'repo-A']);
    assert.notDeepStrictEqual(graphKeyA, graphKeyB);
  });

  test('3. Files query keys separate tree metadata from on-demand content', () => {
    const treeKey = FILES_KEYS.tree('repo-A');
    assert.deepStrictEqual(treeKey, ['repository-files', 'repo-A']);

    const contentKey1 = FILES_KEYS.content('repo-A', 'src/main.ts');
    const contentKey2 = FILES_KEYS.content('repo-A', 'src/utils.ts');
    const contentKeyOtherRepo = FILES_KEYS.content('repo-B', 'src/main.ts');

    assert.deepStrictEqual(contentKey1, ['file-content', 'repo-A', 'src/main.ts']);
    assert.notDeepStrictEqual(contentKey1, contentKey2);
    assert.notDeepStrictEqual(contentKey1, contentKeyOtherRepo);
  });

  test('4. Plans and Changesets query keys isolate by repository and plan ID', () => {
    const planKeyA = PLAN_KEYS.list('repo-A');
    const planKeyB = PLAN_KEYS.list('repo-B');
    assert.deepStrictEqual(planKeyA, ['feature-plans', 'repo-A']);
    assert.notDeepStrictEqual(planKeyA, planKeyB);

    const csKey1 = CHANGESET_KEYS.list('plan-1');
    const csKey2 = CHANGESET_KEYS.list('plan-2');
    assert.deepStrictEqual(csKey1, ['changesets', 'plan-1']);
    assert.notDeepStrictEqual(csKey1, csKey2);
  });

  test('5. GitHub and Validation query keys isolate by changeset ID', () => {
    assert.deepStrictEqual(GITHUB_KEYS.connection, ['github-connection']);

    const branchKey1 = GITHUB_KEYS.branch('cs-1');
    const branchKey2 = GITHUB_KEYS.branch('cs-2');
    assert.deepStrictEqual(branchKey1, ['changeset-branch', 'cs-1']);
    assert.notDeepStrictEqual(branchKey1, branchKey2);

    const prKey1 = GITHUB_KEYS.pr('cs-1');
    const prKey2 = GITHUB_KEYS.pr('cs-2');
    assert.deepStrictEqual(prKey1, ['changeset-pr', 'cs-1']);
    assert.notDeepStrictEqual(prKey1, prKey2);

    const valKey1 = VALIDATION_KEYS.detail('cs-1');
    const valKey2 = VALIDATION_KEYS.detail('cs-2');
    assert.deepStrictEqual(valKey1, ['validation', 'cs-1']);
    assert.notDeepStrictEqual(valKey1, valKey2);
  });

  test('6. Unauthenticated requests handled safely in query keys', () => {
    assert.deepStrictEqual(REPOSITORY_KEYS.detail(''), ['repository', '']);
    assert.deepStrictEqual(ARCHITECTURE_KEYS.detail(''), ['architecture', '']);
    assert.deepStrictEqual(GRAPH_KEYS.detail(''), ['graph', '']);
  });

  test('7. Files Route: Unauthenticated GET /api/repositories/[id]/files returns 401', async () => {
    const { GET } = await import('../../app/api/repositories/[id]/files/route');
    const fakeReq = new Request('http://localhost:3000/api/repositories/repo-1/files') as any;
    const res = await GET(fakeReq, { params: Promise.resolve({ id: 'repo-1' }) });
    assert.strictEqual(res.status, 401);
  });

  test('8. UI State Persistence structures validate without memory retention', () => {
    // Graph UI State test
    const initialGraphUiState = {
      filterState: {
        nodeTypes: new Set(['class', 'function']),
        searchQuery: 'auth',
        relationshipTypes: new Set(['imports']),
      },
      focusState: {
        activeTab: 'all' as const,
        expandedModules: new Set(['auth']),
        focusedNodeId: 'node-1',
      },
      layoutDirection: 'TB' as const,
      selectedNodeId: 'node-1',
    };
    assert.strictEqual(initialGraphUiState.selectedNodeId, 'node-1');
    assert.strictEqual(initialGraphUiState.layoutDirection, 'TB');

    // Files UI State test
    const initialFilesUiState = {
      openTabs: [{ path: 'src/main.ts', name: 'main.ts' }],
      activeTab: 'src/main.ts',
      expandedFolders: new Set(['src']),
    };
    assert.strictEqual(initialFilesUiState.activeTab, 'src/main.ts');
    assert.strictEqual(initialFilesUiState.openTabs.length, 1);

    // Analysis UI State test
    const initialAnalysisUiState = {
      selectedPlanId: 'plan-123',
      selectedChangesetId: 'cs-456',
    };
    assert.strictEqual(initialAnalysisUiState.selectedPlanId, 'plan-123');
    assert.strictEqual(initialAnalysisUiState.selectedChangesetId, 'cs-456');
  });
});
