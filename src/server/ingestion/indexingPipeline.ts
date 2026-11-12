import { ExtractedFile } from './zipExtractor';
import { shouldIndexFile, detectLanguage, sanitizePostgresText } from './fileFilter';
import { CodeParser } from '../parsing/codeParser';
import { ParsedChunk } from '../parsing/types';
import { EmbeddingService } from '../embeddings/embeddingService';
import { SummaryService } from '../summary/summaryService';
import { NodalEngine } from '../analyzer/nodalEngine';
import { query } from '../db/client';

export class IndexingPipeline {
  /**
   * Run the full asynchronous indexing pipeline.
   */
  static async run(
    repositoryId: string,
    extractedFilesOrFn: ExtractedFile[] | (() => Promise<ExtractedFile[]>)
  ): Promise<void> {
    try {
      // Stage 1: EXTRACTING / DOWNLOADING
      await this.updateProgress(repositoryId, 'EXTRACTING', 'Decompressing archive and scanning file trees...', 10);

      const extractedFiles = typeof extractedFilesOrFn === 'function'
        ? await extractedFilesOrFn()
        : extractedFilesOrFn;

      // Stage 2: SCANNING Codebase
      await this.updateProgress(repositoryId, 'SCANNING', 'Filtering binaries and scanning source files...', 25);

      const files = extractedFiles.filter((f) => shouldIndexFile(f.filePath));
      let totalLines = 0;
      const folderSet = new Set<string>();

      // Store files in Supabase in batches
      const fileIdMap = new Map<string, string>();
      const BATCH_FILE_SIZE = 50;

      for (let i = 0; i < files.length; i += BATCH_FILE_SIZE) {
        const batch = files.slice(i, i + BATCH_FILE_SIZE);
        const values: any[] = [];
        const placeholders: string[] = [];

        batch.forEach((file, idx) => {
          const fileId = `file-${Date.now()}-${i + idx}-${Math.random().toString(36).substring(7)}`;
          fileIdMap.set(file.filePath, fileId);
          totalLines += file.lineCount;

          const parts = file.filePath.split('/');
          if (parts.length > 1) {
            folderSet.add(parts.slice(0, -1).join('/'));
          }

          const baseIdx = idx * 8;
          placeholders.push(
            `($${baseIdx + 1}, $${baseIdx + 2}, $${baseIdx + 3}, $${baseIdx + 4}, $${baseIdx + 5}, $${baseIdx + 6}, $${baseIdx + 7}, $${baseIdx + 8})`
          );
          values.push(
            fileId,
            repositoryId,
            file.filePath,
            file.fileName,
            file.extension,
            file.language,
            file.lineCount,
            sanitizePostgresText(file.content)
          );
        });

        if (placeholders.length > 0) {
          await query(
            `INSERT INTO repository_files (id, repository_id, file_path, file_name, extension, language, line_count, content)
             VALUES ${placeholders.join(', ')}
             ON CONFLICT (id) DO NOTHING`,
            values
          );
        }
      }

      // Stage 3 & 4: PARSING & CHUNKING
      await this.updateProgress(repositoryId, 'PARSING', 'Parsing class declarations, functions, and symbols...', 45);

      const allChunks: ParsedChunk[] = [];
      for (const file of files) {
        const chunks = CodeParser.parseFile(file.filePath, file.content, file.language);
        allChunks.push(...chunks);
      }

      // Prioritize chunks (classes, controllers, functions, configs first)
      const prioritizedChunks = allChunks.sort((a, b) => {
        const score = (c: ParsedChunk) => {
          if (c.symbolType === 'controller') return 5;
          if (c.symbolType === 'class') return 4;
          if (c.symbolType === 'function' || c.symbolType === 'method') return 3;
          if (['pom.xml', 'package.json', 'application.yml', 'schema.sql'].some(k => c.filePath.toLowerCase().endsWith(k))) return 4;
          return 1;
        };
        return score(b) - score(a);
      });

      // Cap at top 400 most significant semantic chunks for fast, robust vector storage
      const MAX_CHUNKS = 400;
      const chunksToIndex = prioritizedChunks.slice(0, MAX_CHUNKS);

      await this.updateProgress(repositoryId, 'CHUNKING', `Created ${chunksToIndex.length} semantic code units...`, 60);

      // Stage: AST Symbol & Code Relationship Graph Analysis (Phase 2 Engine)
      try {
        await this.updateProgress(repositoryId, 'PARSING', 'Extracting AST symbols and mapping relationships...', 68);
        const graphResult = await NodalEngine.analyzeAndStore(repositoryId, files);
        console.log(
          `📊 AST Graph analysis complete for ${repositoryId}: ${graphResult.symbols.length} symbols, ${graphResult.relationships.length} relationships, ${graphResult.errors.length} file notices.`
        );
      } catch (graphErr) {
        // Graceful non-blocking error handling to ensure Phase 1 indexing is never interrupted
        console.error(`⚠️ AST Graph analysis encountered a non-fatal error for repository ${repositoryId}:`, graphErr);
      }

      // Detect Technologies and Calculate Stats
      const technologies = SummaryService.detectTechnologies(files);
      const stats = SummaryService.calculateStats(files, allChunks);

      // Stage 5: VECTOR EMBEDDING GENERATION & STORAGE
      await this.updateProgress(repositoryId, 'EMBEDDING', `Generating vector embeddings for ${chunksToIndex.length} units...`, 75);

      const chunkTexts = chunksToIndex.map((c) => {
        const symbolHeader = c.symbolName ? `[${c.symbolType || 'symbol'}: ${c.symbolName}]\n` : '';
        return `File: ${c.filePath}\nLanguage: ${c.language}\n${symbolHeader}${c.content}`;
      });

      // Generate embeddings in chunks with live progress updates
      const EMBED_SUB_BATCH = 25;
      const allEmbeddings: number[][] = [];

      for (let i = 0; i < chunkTexts.length; i += EMBED_SUB_BATCH) {
        const subBatch = chunkTexts.slice(i, i + EMBED_SUB_BATCH);
        const subEmbeds = await EmbeddingService.embedBatch(subBatch);
        allEmbeddings.push(...subEmbeds);

        const currentPct = 75 + Math.floor(((i + subBatch.length) / chunkTexts.length) * 15);
        await this.updateProgress(
          repositoryId,
          'EMBEDDING',
          `Vectorized ${Math.min(i + EMBED_SUB_BATCH, chunkTexts.length)} / ${chunkTexts.length} chunks...`,
          currentPct
        );
      }

      // Bulk insert code chunks into PostgreSQL
      const CHUNK_INSERT_BATCH = 30;
      for (let i = 0; i < chunksToIndex.length; i += CHUNK_INSERT_BATCH) {
        const batch = chunksToIndex.slice(i, i + CHUNK_INSERT_BATCH);
        const values: any[] = [];
        const placeholders: string[] = [];

        batch.forEach((chunk, idx) => {
          const globalIdx = i + idx;
          const embedding = allEmbeddings[globalIdx];
          const chunkId = `chunk-${Date.now()}-${globalIdx}-${Math.random().toString(36).substring(7)}`;
          const fileId = fileIdMap.get(chunk.filePath) || `file-${Date.now()}`;
          const vectorStr = embedding ? EmbeddingService.formatPgVector(embedding) : null;

          const baseIdx = idx * 11;
          placeholders.push(
            `($${baseIdx + 1}, $${baseIdx + 2}, $${baseIdx + 3}, $${baseIdx + 4}, $${baseIdx + 5}, $${baseIdx + 6}::vector, $${baseIdx + 7}, $${baseIdx + 8}, $${baseIdx + 9}, $${baseIdx + 10}, $${baseIdx + 11})`
          );
          values.push(
            chunkId,
            repositoryId,
            fileId,
            chunk.filePath,
            sanitizePostgresText(chunk.content),
            vectorStr,
            chunk.startLine,
            chunk.endLine,
            chunk.language,
            chunk.symbolName || null,
            chunk.symbolType || 'block'
          );
        });

        if (placeholders.length > 0) {
          await query(
            `INSERT INTO code_chunks (id, repository_id, file_id, file_path, content, embedding, start_line, end_line, language, symbol_name, symbol_type)
             VALUES ${placeholders.join(', ')}
             ON CONFLICT (id) DO NOTHING`,
            values
          );
        }
      }

      // Stage 6: Generate Factual Repository Summary
      await this.updateProgress(repositoryId, 'EMBEDDING', 'Synthesizing architecture overview...', 92);

      const repoNameRes = await query(`SELECT name FROM repositories WHERE id = $1`, [repositoryId]);
      const repoName = repoNameRes.rows[0]?.name || 'Repository';
      const summary = await SummaryService.generateSummary(repoName, files, technologies, stats);

      // Final Stage: COMPLETED
      await query(
        `UPDATE repositories
         SET status = 'COMPLETED',
             stage = 'Completed',
             progress = 100,
             file_count = $2,
             folder_count = $3,
             line_count = $4,
             token_count = $5,
             primary_language = $6,
             framework = $7,
             technologies = $8::jsonb,
             summary = $9::jsonb,
             stats = $10::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [
          repositoryId,
          files.length,
          folderSet.size,
          totalLines,
          totalLines * 4,
          technologies.find((t) => t.category === 'language')?.name || 'Plain Text',
          technologies.find((t) => t.category === 'framework')?.name || null,
          JSON.stringify(technologies),
          JSON.stringify(summary),
          JSON.stringify(stats),
        ]
      );

      console.log(`✅ Repository ${repositoryId} indexing COMPLETED successfully!`);
    } catch (err: any) {
      console.error(`❌ Indexing error for repository ${repositoryId}:`, err);
      await this.updateError(repositoryId, err?.message || 'Indexing failed due to an unexpected error.');
    }
  }

  private static async updateProgress(
    repositoryId: string,
    stage: string,
    message: string,
    progress: number
  ): Promise<void> {
    try {
      await query(
        `UPDATE repositories
         SET status = 'INDEXING',
             stage = $2,
             error_message = $3,
             progress = $4,
             updated_at = NOW()
         WHERE id = $1`,
        [repositoryId, stage, message, progress]
      );
    } catch (e) {
      console.warn('Could not update indexing progress:', e);
    }
  }

  private static async updateError(repositoryId: string, errorMessage: string): Promise<void> {
    try {
      await query(
        `UPDATE repositories
         SET status = 'FAILED',
             stage = 'Failed',
             error_message = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [repositoryId, errorMessage]
      );
    } catch (e) {
      console.warn('Could not update indexing error:', e);
    }
  }
}
