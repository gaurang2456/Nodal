import fs from 'fs';
import path from 'path';
import os from 'os';
import { query } from '../db/client';
import { GeneratedFileChange } from '@/types';

export class WorkspaceService {
  /**
   * Validates that a relative file path is strictly contained within the workspace root.
   * Rejects path traversal (../), absolute paths, and invalid paths.
   */
  static validateSafePath(workspaceRoot: string, relativePath: string): string {
    if (!relativePath || typeof relativePath !== 'string') {
      throw new Error('Invalid file path provided.');
    }

    if (relativePath.includes('..') || path.isAbsolute(relativePath)) {
      throw new Error(`Path traversal violation detected: ${relativePath}`);
    }

    const resolved = path.resolve(workspaceRoot, relativePath);
    const resolvedRoot = path.resolve(workspaceRoot);

    if (!resolved.startsWith(resolvedRoot)) {
      throw new Error(`Path escapes workspace directory: ${relativePath}`);
    }

    return resolved;
  }

  /**
   * Creates a dedicated, isolated temporary workspace directory.
   */
  static async createWorkspace(repositoryId: string, validationId: string): Promise<string> {
    const baseTempDir = path.join(os.tmpdir(), 'nodal-val', repositoryId, validationId);
    await fs.promises.mkdir(baseTempDir, { recursive: true });
    return baseTempDir;
  }

  /**
   * Reconstructs the entire repository in the temporary workspace from repository_files.
   */
  static async reconstructRepository(workspacePath: string, repositoryId: string): Promise<number> {
    const filesRes = await query(
      `SELECT file_path, content
       FROM repository_files
       WHERE repository_id = $1`,
      [repositoryId]
    );

    let writtenCount = 0;
    for (const file of filesRes.rows) {
      try {
        const destPath = this.validateSafePath(workspacePath, file.file_path);
        const parentDir = path.dirname(destPath);
        await fs.promises.mkdir(parentDir, { recursive: true });
        await fs.promises.writeFile(destPath, file.content || '', 'utf8');
        writtenCount++;
      } catch (err: any) {
        console.warn(`[WorkspaceService] Skipping invalid file path ${file.file_path}:`, err?.message);
      }
    }

    return writtenCount;
  }

  /**
   * Applies the proposed changeset (modify, create, delete) to the temporary workspace.
   */
  static async applyChangeset(
    workspacePath: string,
    changes: GeneratedFileChange[]
  ): Promise<{ modified: number; created: number; deleted: number }> {
    let modified = 0;
    let created = 0;
    let deleted = 0;

    for (const change of changes) {
      const destPath = this.validateSafePath(workspacePath, change.filePath);

      if (change.changeType === 'modify') {
        const parentDir = path.dirname(destPath);
        await fs.promises.mkdir(parentDir, { recursive: true });
        await fs.promises.writeFile(destPath, change.proposedContent || '', 'utf8');
        modified++;
      } else if (change.changeType === 'create') {
        const parentDir = path.dirname(destPath);
        await fs.promises.mkdir(parentDir, { recursive: true });
        await fs.promises.writeFile(destPath, change.proposedContent || '', 'utf8');
        created++;
      } else if (change.changeType === 'delete') {
        if (fs.existsSync(destPath)) {
          await fs.promises.unlink(destPath);
          deleted++;
        }
      }
    }

    return { modified, created, deleted };
  }

  /**
   * Safely removes the temporary workspace directory.
   */
  static async cleanupWorkspace(workspacePath: string): Promise<void> {
    try {
      if (workspacePath && fs.existsSync(workspacePath)) {
        await fs.promises.rm(workspacePath, { recursive: true, force: true });
      }
    } catch (err: any) {
      console.warn(`[WorkspaceService] Workspace cleanup warning for ${workspacePath}:`, err?.message);
    }
  }
}
