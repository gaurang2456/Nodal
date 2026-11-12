import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';

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

import { WorkspaceService } from '../validation/workspaceService';
import { runSafeCommand, stripAnsi } from '../validation/commandRunner';
import { CodeValidationService } from '../validation/codeValidationService';
import { CodeGeneratorService } from '../planner/codeGeneratorService';
import { ensureDatabaseSchema, query, getDbPool } from '../db/client';

describe('Phase 3 Part 2: Generated Code Validation & Testing Engine Tests', () => {
  const userA = { id: 'a1b2c3d4-3333-3333-3333-aaaaaaaaaaaa', email: 'usera@example.com' };

  test('1. Workspace Path Security: blocks directory traversal (../../) and escaping paths', () => {
    const tempRoot = path.join(os.tmpdir(), 'nodal-security-test');

    assert.throws(
      () => WorkspaceService.validateSafePath(tempRoot, '../../etc/passwd'),
      /Path traversal violation detected/
    );

    assert.throws(
      () => WorkspaceService.validateSafePath(tempRoot, '..\\..\\windows\\system32'),
      /Path traversal violation detected/
    );

    const safe = WorkspaceService.validateSafePath(tempRoot, 'src/auth/service.ts');
    assert.ok(safe.startsWith(tempRoot));
  });

  test('2. Compiler Error Parsing: parses TypeScript errors into structured ValidationError objects', () => {
    const rawOutput = `
src/services/user.service.ts(42,5): error TS2322: Type 'string' is not assignable to type 'number'.
src/auth/auth.controller.ts:18:10 - error TS2304: Cannot find name 'OAuthService'.
src/config.ts:5:1 - warning TS2307: Cannot find module './local' or its corresponding type declarations.
`;

    const errors = CodeValidationService.parseCompilerErrors(rawOutput);
    assert.strictEqual(errors.length, 3);

    assert.strictEqual(errors[0].filePath, 'src/services/user.service.ts');
    assert.strictEqual(errors[0].line, 42);
    assert.strictEqual(errors[0].column, 5);
    assert.strictEqual(errors[0].severity, 'error');
    assert.ok(errors[0].message.includes("Type 'string' is not assignable"));

    assert.strictEqual(errors[1].filePath, 'src/auth/auth.controller.ts');
    assert.strictEqual(errors[1].line, 18);
    assert.strictEqual(errors[1].column, 10);
    assert.strictEqual(errors[1].severity, 'error');

    assert.strictEqual(errors[2].filePath, 'src/config.ts');
    assert.strictEqual(errors[2].severity, 'warning');
  });

  test('3. ANSI Escape Code Stripping: cleans ANSI colors and orphaned brackets from compiler logs', () => {
    const textWithAnsi = '\u001b[41m\u001b[37m[ERROR]\u001b[0m src/app.ts:5:1 - Type mismatch\u001b[0m';
    const cleaned = stripAnsi(textWithAnsi);
    assert.strictEqual(cleaned, '[ERROR] src/app.ts:5:1 - Type mismatch');

    const orphanedBrackets = '[41m[37mFailed[0m';
    assert.strictEqual(stripAnsi(orphanedBrackets), 'Failed');
  });

  test('4. Command Runner: captures execution results and enforces timeout', async () => {
    // Run short fast command
    const res = await runSafeCommand({
      command: 'node',
      args: ['-e', 'console.log("HELLO_VALIDATION"); process.exit(0);'],
      cwd: process.cwd(),
      timeoutMs: 5000,
    });

    assert.strictEqual(res.exitCode, 0);
    assert.ok(res.stdout.includes('HELLO_VALIDATION'));
    assert.strictEqual(res.timedOut, false);

    // Run command that exceeds timeout
    const timeoutRes = await runSafeCommand({
      command: 'node',
      args: ['-e', 'setTimeout(() => {}, 10000);'],
      cwd: process.cwd(),
      timeoutMs: 500,
    });

    assert.strictEqual(timeoutRes.timedOut, true);
  });

  test('5. Repository without tsconfig.json: skips TypeScript validation gracefully without failing', async () => {
    if (!process.env.DATABASE_URL) return;
    await ensureDatabaseSchema();

    const repoId = `test-no-ts-repo-${Date.now()}`;
    const planId = `test-no-ts-plan-${Date.now()}`;

    await query(
      `INSERT INTO repositories (id, name, full_name, source_type, user_id, status)
       VALUES ($1, 'NoTsRepo', 'usera/no-ts-repo', 'zip', $2, 'COMPLETED')`,
      [repoId, userA.id]
    );

    // Only package.json, NO tsconfig.json
    await query(
      `INSERT INTO repository_files (id, repository_id, file_path, file_name, extension, language, line_count, content)
       VALUES ($1, $2, 'package.json', 'package.json', '.json', 'json', 5, '{"name":"no-ts"}'),
              ($3, $2, 'index.js', 'index.js', '.js', 'javascript', 2, 'module.exports = {};')`,
      [`file-pkg-${Date.now()}`, repoId, `file-js-${Date.now()}`]
    );

    const planData = {
      overview: 'No TS plan',
      relevantArchitecture: [],
      filesToModify: [{ filePath: 'index.js', symbols: [], reason: 'Update js module' }],
      filesToCreate: [],
      dependencies: [],
      databaseChanges: [],
      apiChanges: [],
      implementationSteps: [],
      potentialSideEffects: [],
      evidence: { files: ['index.js'], symbols: [], chunkCount: 1 },
    };

    await query(
      `INSERT INTO feature_plans (id, repository_id, user_id, feature_request, plan_json, status)
       VALUES ($1, $2, $3, 'Test No TsConfig', $4, 'COMPLETED')`,
      [planId, repoId, userA.id, JSON.stringify(planData)]
    );

    const changeset = await CodeGeneratorService.generateCodeChanges(planId, userA.id);
    const valResult = await CodeValidationService.validateChangeset(changeset.id, userA.id);

    assert.ok(valResult.id);
    // Overall status is skipped since no tsconfig and no other checks ran
    assert.strictEqual(valResult.status, 'skipped');
    assert.strictEqual(valResult.overallStatus, 'skipped');
    const tsCheck = valResult.checks.find((c) => c.type === 'typecheck');
    assert.ok(tsCheck);
    assert.strictEqual(tsCheck.status, 'skipped');
    assert.ok(tsCheck.output?.includes('No tsconfig.json found'));

    await query(`DELETE FROM repositories WHERE id = $1`, [repoId]);
  });

  test('6. Repository with tsconfig.json but missing local TypeScript: marked skipped, NOT failed', async () => {
    if (!process.env.DATABASE_URL) return;
    await ensureDatabaseSchema();

    const repoId = `test-missing-ts-${Date.now()}`;
    const planId = `test-missing-ts-plan-${Date.now()}`;

    await query(
      `INSERT INTO repositories (id, name, full_name, source_type, user_id, status)
       VALUES ($1, 'MissingTsRepo', 'usera/missing-ts', 'zip', $2, 'COMPLETED')`,
      [repoId, userA.id]
    );

    // tsconfig.json exists, but NO node_modules
    await query(
      `INSERT INTO repository_files (id, repository_id, file_path, file_name, extension, language, line_count, content)
       VALUES ($1, $2, 'tsconfig.json', 'tsconfig.json', '.json', 'json', 5, '{"compilerOptions":{}}'),
              ($3, $2, 'src/main.ts', 'main.ts', '.ts', 'typescript', 2, 'export const x = 1;')`,
      [`file-tsconf-${Date.now()}`, repoId, `file-ts-${Date.now()}`]
    );

    const planData = {
      overview: 'Missing local TypeScript test',
      relevantArchitecture: [],
      filesToModify: [{ filePath: 'src/main.ts', symbols: [], reason: 'Add prop' }],
      filesToCreate: [],
      dependencies: [],
      databaseChanges: [],
      apiChanges: [],
      implementationSteps: [],
      potentialSideEffects: [],
      evidence: { files: ['src/main.ts'], symbols: [], chunkCount: 1 },
    };

    await query(
      `INSERT INTO feature_plans (id, repository_id, user_id, feature_request, plan_json, status)
       VALUES ($1, $2, $3, 'Test Missing TS', $4, 'COMPLETED')`,
      [planId, repoId, userA.id, JSON.stringify(planData)]
    );

    const changeset = await CodeGeneratorService.generateCodeChanges(planId, userA.id);
    const valResult = await CodeValidationService.validateChangeset(changeset.id, userA.id);

    // Must NOT fail; must be marked as skipped!
    assert.strictEqual(valResult.status, 'skipped');
    const tsCheck = valResult.checks.find((c) => c.type === 'typecheck');
    assert.ok(tsCheck);
    assert.strictEqual(tsCheck.status, 'skipped');
    assert.ok(tsCheck.output?.includes('TypeScript is not installed in the target repository'));

    await query(`DELETE FROM repositories WHERE id = $1`, [repoId]);
  });

  test('7. Repository with local TypeScript installed: passes on valid generated code', async () => {
    if (!process.env.DATABASE_URL) return;
    await ensureDatabaseSchema();

    const repoId = `test-valid-ts-${Date.now()}`;
    const planId = `test-valid-ts-plan-${Date.now()}`;

    await query(
      `INSERT INTO repositories (id, name, full_name, source_type, user_id, status)
       VALUES ($1, 'ValidTsRepo', 'usera/valid-ts', 'zip', $2, 'COMPLETED')`,
      [repoId, userA.id]
    );

    const mockTscScript = 'console.log("TypeScript compilation success"); process.exit(0);';

    await query(
      `INSERT INTO repository_files (id, repository_id, file_path, file_name, extension, language, line_count, content)
       VALUES ($1, $2, 'tsconfig.json', 'tsconfig.json', '.json', 'json', 3, '{"compilerOptions":{}}'),
              ($3, $2, 'node_modules/typescript/bin/tsc', 'tsc', '', 'javascript', 1, $4),
              ($5, $2, 'src/math.ts', 'math.ts', '.ts', 'typescript', 2, 'export function add(a: number, b: number) { return a + b; }')`,
      [
        `file-cfg-${Date.now()}`, repoId,
        `file-bin-${Date.now()}`, mockTscScript,
        `file-src-${Date.now()}`,
      ]
    );

    const planData = {
      overview: 'Valid code test',
      relevantArchitecture: [],
      filesToModify: [{ filePath: 'src/math.ts', symbols: ['add'], reason: 'Add multiply' }],
      filesToCreate: [],
      dependencies: [],
      databaseChanges: [],
      apiChanges: [],
      implementationSteps: [],
      potentialSideEffects: [],
      evidence: { files: ['src/math.ts'], symbols: [], chunkCount: 1 },
    };

    await query(
      `INSERT INTO feature_plans (id, repository_id, user_id, feature_request, plan_json, status)
       VALUES ($1, $2, $3, 'Valid TS Changes', $4, 'COMPLETED')`,
      [planId, repoId, userA.id, JSON.stringify(planData)]
    );

    const changeset = await CodeGeneratorService.generateCodeChanges(planId, userA.id);
    const valResult = await CodeValidationService.validateChangeset(changeset.id, userA.id);

    assert.strictEqual(valResult.status, 'passed');
    const tsCheck = valResult.checks.find((c) => c.type === 'typecheck');
    assert.ok(tsCheck);
    assert.strictEqual(tsCheck.status, 'passed');

    await query(`DELETE FROM repositories WHERE id = $1`, [repoId]);
  });

  test('8. Repository with local TypeScript: fails and captures errors on invalid generated code', async () => {
    if (!process.env.DATABASE_URL) return;
    await ensureDatabaseSchema();

    const repoId = `test-invalid-ts-${Date.now()}`;
    const planId = `test-invalid-ts-plan-${Date.now()}`;

    await query(
      `INSERT INTO repositories (id, name, full_name, source_type, user_id, status)
       VALUES ($1, 'InvalidTsRepo', 'usera/invalid-ts', 'zip', $2, 'COMPLETED')`,
      [repoId, userA.id]
    );

    // Mock local tsc that emits an error and exits with code 1
    const mockTscScript =
      'console.error("src/math.ts:10:5 - error TS2322: Type \\"string\\" is not assignable to type \\"number\\"."); process.exit(1);';

    await query(
      `INSERT INTO repository_files (id, repository_id, file_path, file_name, extension, language, line_count, content)
       VALUES ($1, $2, 'tsconfig.json', 'tsconfig.json', '.json', 'json', 3, '{"compilerOptions":{}}'),
              ($3, $2, 'node_modules/typescript/bin/tsc', 'tsc', '', 'javascript', 1, $4),
              ($5, $2, 'src/math.ts', 'math.ts', '.ts', 'typescript', 2, 'export const val: number = 1;')`,
      [
        `file-cfg2-${Date.now()}`, repoId,
        `file-bin2-${Date.now()}`, mockTscScript,
        `file-src2-${Date.now()}`,
      ]
    );

    const planData = {
      overview: 'Invalid code test',
      relevantArchitecture: [],
      filesToModify: [{ filePath: 'src/math.ts', symbols: [], reason: 'Assign string to number' }],
      filesToCreate: [],
      dependencies: [],
      databaseChanges: [],
      apiChanges: [],
      implementationSteps: [],
      potentialSideEffects: [],
      evidence: { files: ['src/math.ts'], symbols: [], chunkCount: 1 },
    };

    await query(
      `INSERT INTO feature_plans (id, repository_id, user_id, feature_request, plan_json, status)
       VALUES ($1, $2, $3, 'Invalid TS Changes', $4, 'COMPLETED')`,
      [planId, repoId, userA.id, JSON.stringify(planData)]
    );

    const changeset = await CodeGeneratorService.generateCodeChanges(planId, userA.id);
    const valResult = await CodeValidationService.validateChangeset(changeset.id, userA.id);

    assert.strictEqual(valResult.status, 'failed');
    const tsCheck = valResult.checks.find((c) => c.type === 'typecheck');
    assert.ok(tsCheck);
    assert.strictEqual(tsCheck.status, 'failed');
    assert.ok(tsCheck.errors && tsCheck.errors.length > 0);
    assert.strictEqual(tsCheck.errors[0].filePath, 'src/math.ts');
    assert.strictEqual(tsCheck.errors[0].line, 10);
    assert.strictEqual(tsCheck.errors[0].column, 5);

    await query(`DELETE FROM repositories WHERE id = $1`, [repoId]);
  });

  test('9. Temporary Workspace Isolation: original repository files in DB are never modified and temp dir is removed', async () => {
    if (!process.env.DATABASE_URL) return;
    await ensureDatabaseSchema();

    const repoId = `test-iso-repo-${Date.now()}`;
    const planId = `test-iso-plan-${Date.now()}`;

    const originalContent = 'export const ORIGINAL = "DO_NOT_CHANGE";';

    await query(
      `INSERT INTO repositories (id, name, full_name, source_type, user_id, status)
       VALUES ($1, 'IsolationTestRepo', 'usera/iso-repo', 'zip', $2, 'COMPLETED')`,
      [repoId, userA.id]
    );

    await query(
      `INSERT INTO repository_files (id, repository_id, file_path, file_name, extension, language, line_count, content)
       VALUES ($1, $2, 'src/config.ts', 'config.ts', '.ts', 'typescript', 1, $3)`,
      [`file-cfg-${Date.now()}`, repoId, originalContent]
    );

    const planData = {
      overview: 'Isolation test',
      relevantArchitecture: [],
      filesToModify: [{ filePath: 'src/config.ts', symbols: [], reason: 'Modify config' }],
      filesToCreate: [],
      dependencies: [],
      databaseChanges: [],
      apiChanges: [],
      implementationSteps: [],
      potentialSideEffects: [],
      evidence: { files: ['src/config.ts'], symbols: [], chunkCount: 1 },
    };

    await query(
      `INSERT INTO feature_plans (id, repository_id, user_id, feature_request, plan_json, status)
       VALUES ($1, $2, $3, 'Isolation Test Plan', $4, 'COMPLETED')`,
      [planId, repoId, userA.id, JSON.stringify(planData)]
    );

    const changeset = await CodeGeneratorService.generateCodeChanges(planId, userA.id);
    await CodeValidationService.validateChangeset(changeset.id, userA.id);

    // Verify DB original content is 100% UNTOUCHED
    const checkFileRes = await query(
      `SELECT content FROM repository_files WHERE repository_id = $1 AND file_path = 'src/config.ts'`,
      [repoId]
    );

    assert.strictEqual(checkFileRes.rows[0].content, originalContent);

    // Verify temporary workspace directory is completely cleaned up
    const baseTempDir = path.join(os.tmpdir(), 'nodal-val', repoId);
    if (fs.existsSync(baseTempDir)) {
      const remainingChildren = fs.readdirSync(baseTempDir);
      assert.strictEqual(remainingChildren.length, 0);
    }

    await query(`DELETE FROM repositories WHERE id = $1`, [repoId]);
  });

  after(async () => {
    try {
      await getDbPool().end();
    } catch {}
  });
});
