import OpenAI from 'openai';
import { query } from '../db/client';
import { EmbeddingService } from '../embeddings/embeddingService';

export interface RetrievedChunk {
  id: string;
  repositoryId: string;
  fileId: string;
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  language: string;
  symbolName: string | null;
  similarity: number;
  matchSource?: 'filename' | 'symbol' | 'semantic' | 'relationship';
}

export interface HybridRetrievalResult {
  chunks: RetrievedChunk[];
  symbols: Array<{
    name: string;
    type: string;
    file_path: string;
    start_line: number;
    end_line: number;
  }>;
  relationships: Array<{
    source_symbol_id: string;
    target_symbol_id: string;
    relationship_type: string;
  }>;
  evidenceItems: Array<{
    filePath: string;
    symbols: string[];
    matchSource: 'filename' | 'symbol' | 'semantic' | 'relationship';
    similarity?: number;
  }>;
  retrievalConfidence: 'high' | 'medium' | 'low';
  lexicalMatchedFiles: string[];
  extractedSignals: {
    fileNames: string[];
    identifiers: string[];
  };
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'where', 'what', 'which',
  'have', 'has', 'had', 'does', 'did', 'not', 'non', 'functional', 'broken', 'issue', 'bug',
  'feature', 'fix', 'fixes', 'fixed', 'error', 'fail', 'fails', 'failed', 'failing', 'work',
  'works', 'working', 'button', 'click', 'clicking', 'page', 'component', 'user', 'users',
  'please', 'should', 'could', 'would', 'need', 'needs', 'make', 'add', 'update', 'change',
  'remove', 'delete', 'create', 'open', 'close', 'show', 'hide', 'loading', 'state', 'data',
  'true', 'false', 'null', 'undefined', 'http', 'https', 'github', 'com', 'issues',
]);

export function extractIssueSignals(queryText: string): {
  filePaths: string[];
  fileNames: string[];
  fileStems: string[];
  identifiers: string[];
} {
  const filePaths = new Set<string>();
  const fileNames = new Set<string>();
  const fileStems = new Set<string>();
  const identifiers = new Set<string>();

  if (!queryText) {
    return { filePaths: [], fileNames: [], fileStems: [], identifiers: [] };
  }

  // Strip GitHub URLs so repo/owner names don't pollute file matching unless echoed elsewhere
  const sanitized = queryText.replace(/https?:\/\/github\.com\/[^\s)]+/gi, ' ');

  // 1. Match explicit filenames or paths with common source extensions
  const fileRegex = /(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:tsx?|jsx?|mjs|cjs|py|java|go|rs|rb|php|cs|cpp|c|h|vue|svelte|css|scss|html|sql|json|ya?ml|md)\b/gi;
  for (const match of sanitized.matchAll(fileRegex)) {
    const raw = match[0].trim();
    const base = raw.split('/').pop() || raw;
    const stem = base.replace(/\.[^.]+$/, '');
    if (raw.includes('/')) {
      filePaths.add(raw.toLowerCase());
    }
    fileNames.add(base.toLowerCase());
    if (stem.length >= 2 && !STOP_WORDS.has(stem.toLowerCase())) {
      fileStems.add(stem.toLowerCase());
      identifiers.add(stem.toLowerCase());
    }
  }

  // 2. Backticked code tokens
  for (const match of sanitized.matchAll(/`([^`\n]{2,80})`/g)) {
    const token = match[1].trim();
    for (const part of token.split(/[\s(),:;]+/)) {
      const cleaned = part.replace(/^[./]+/, '');
      if (cleaned.length >= 3 && !STOP_WORDS.has(cleaned.toLowerCase())) {
        identifiers.add(cleaned.toLowerCase());
      }
    }
  }

  // 3. CamelCase / PascalCase / snake_case / meaningful capitalized tokens
  for (const match of sanitized.matchAll(/\b[A-Za-z_][A-Za-z0-9_]{2,60}\b/g)) {
    const word = match[0];
    const lower = word.toLowerCase();
    if (STOP_WORDS.has(lower)) continue;
    const isCamelOrPascal = /[a-z][A-Z]/.test(word) || /^[A-Z][a-zA-Z0-9]{2,}$/.test(word);
    const isSnake = word.includes('_');
    if (isCamelOrPascal || isSnake) {
      identifiers.add(lower);
    }
  }

  return {
    filePaths: Array.from(filePaths),
    fileNames: Array.from(fileNames),
    fileStems: Array.from(fileStems),
    identifiers: Array.from(identifiers).slice(0, 20),
  };
}

export interface RagResponse {
  answer: string;
  citations: Array<{
    id: string;
    filename: string;
    path: string;
    lineRange: string;
    startLine: number;
    endLine: number;
    language: string;
    similarity: number;
    snippet: string;
  }>;
  confidenceScore: number;
  implementationPlan?: string[];
}

export class RagService {
  /**
   * Performs vector similarity retrieval against code_chunks strictly scoped to repository_id.
   */
  static async retrieveRelevantChunks(
    repositoryId: string,
    queryText: string,
    topK: number = 8
  ): Promise<RetrievedChunk[]> {
    try {
      const queryEmbedding = await EmbeddingService.embedQuery(queryText);
      const vectorStr = EmbeddingService.formatPgVector(queryEmbedding);

      const sql = `
        SELECT 
          id,
          repository_id,
          file_id,
          file_path,
          content,
          start_line,
          end_line,
          language,
          symbol_name,
          COALESCE(1 - (embedding <=> $1::vector), 0.8) AS similarity
        FROM code_chunks
        WHERE repository_id = $2
        ORDER BY embedding <=> $1::vector ASC
        LIMIT $3
      `;

      const result = await query(sql, [vectorStr, repositoryId, topK]);

      return result.rows.map((row) => ({
        id: row.id,
        repositoryId: row.repository_id,
        fileId: row.file_id,
        filePath: row.file_path,
        content: row.content,
        startLine: row.start_line,
        endLine: row.end_line,
        language: row.language,
        symbolName: row.symbol_name,
        similarity: Number(row.similarity),
        matchSource: 'semantic' as const,
      }));
    } catch (err: any) {
      console.warn('Vector retrieval fallback:', err?.message);
      return [];
    }
  }

  /**
   * Performs hybrid lexical (file path/name + symbol) AND vector similarity retrieval,
   * falling back directly to repository_files.content for matched files without code_chunks.
   */
  static async retrieveHybridContext(
    repositoryId: string,
    queryText: string,
    topK: number = 12
  ): Promise<HybridRetrievalResult> {
    const signals = extractIssueSignals(queryText);

    // 1. Run vector similarity retrieval in parallel with lexical file & symbol lookups
    const vectorPromise = this.retrieveRelevantChunks(repositoryId, queryText, 10);

    const fileLookupPromise = (async () => {
      if (
        signals.filePaths.length === 0 &&
        signals.fileNames.length === 0 &&
        signals.fileStems.length === 0
      ) {
        return [] as Array<{ id: string; file_path: string; file_name: string; language: string; line_count: number; score: number }>;
      }

      const res = await query(
        `SELECT id, file_path, file_name, language, line_count
         FROM repository_files
         WHERE repository_id = $1`,
        [repositoryId]
      );

      const scored: Array<{ id: string; file_path: string; file_name: string; language: string; line_count: number; score: number }> = [];
      for (const row of res.rows) {
        const fpLower = String(row.file_path || '').toLowerCase();
        const fnLower = String(row.file_name || '').toLowerCase();
        const stemLower = fnLower.replace(/\.[^.]+$/, '');
        let score = 0;

        if (signals.filePaths.some((p) => fpLower === p || fpLower.endsWith('/' + p))) {
          score = Math.max(score, 100);
        }
        if (signals.fileNames.includes(fnLower)) {
          score = Math.max(score, 90);
        }
        if (signals.fileStems.includes(stemLower)) {
          score = Math.max(score, 65);
        }
        if (
          score === 0 &&
          signals.identifiers.some((ident) => ident.length >= 4 && stemLower === ident)
        ) {
          score = Math.max(score, 55);
        }

        if (score > 0) {
          scored.push({
            id: row.id,
            file_path: row.file_path,
            file_name: row.file_name,
            language: row.language,
            line_count: Number(row.line_count || 0),
            score,
          });
        }
      }

      return scored.sort((a, b) => b.score - a.score).slice(0, 6);
    })();

    const symbolLookupPromise = (async () => {
      if (signals.identifiers.length === 0) {
        return [] as Array<{ name: string; type: string; file_path: string; start_line: number; end_line: number }>;
      }
      const res = await query(
        `SELECT name, type, file_path, start_line, end_line
         FROM code_symbols
         WHERE repository_id = $1
           AND LOWER(name) = ANY($2)
         LIMIT 25`,
        [repositoryId, signals.identifiers]
      );
      return res.rows;
    })();

    const [vectorChunks, matchedFiles, directSymbols] = await Promise.all([
      vectorPromise,
      fileLookupPromise,
      symbolLookupPromise,
    ]);

    const lexicalFileScore = new Map<string, number>();
    const lexicalMatchReason = new Map<string, 'filename' | 'symbol'>();

    for (const f of matchedFiles) {
      lexicalFileScore.set(f.file_path, f.score);
      lexicalMatchReason.set(f.file_path, 'filename');
    }
    for (const s of directSymbols) {
      if (!lexicalFileScore.has(s.file_path)) {
        lexicalFileScore.set(s.file_path, 50);
        lexicalMatchReason.set(s.file_path, 'symbol');
      }
    }

    const lexicalMatchedPaths = Array.from(lexicalFileScore.keys()).slice(0, 6);

    // 2. Fetch existing chunks for lexically matched files, and fall back to repository_files.content if unchunked
    const pinnedChunks: RetrievedChunk[] = [];
    if (lexicalMatchedPaths.length > 0) {
      const chunksRes = await query(
        `SELECT id, repository_id, file_id, file_path, content, start_line, end_line, language, symbol_name
         FROM code_chunks
         WHERE repository_id = $1 AND file_path = ANY($2)
         ORDER BY start_line ASC
         LIMIT 12`,
        [repositoryId, lexicalMatchedPaths]
      );

      const filesWithChunks = new Set<string>();
      for (const row of chunksRes.rows) {
        filesWithChunks.add(row.file_path);
        pinnedChunks.push({
          id: row.id,
          repositoryId: row.repository_id,
          fileId: row.file_id,
          filePath: row.file_path,
          content: row.content,
          startLine: row.start_line,
          endLine: row.end_line,
          language: row.language,
          symbolName: row.symbol_name,
          similarity: 0.96,
          matchSource: lexicalMatchReason.get(row.file_path) || 'filename',
        });
      }

      const unchunkedPaths = lexicalMatchedPaths.filter((p) => !filesWithChunks.has(p));
      if (unchunkedPaths.length > 0) {
        const rawRes = await query(
          `SELECT id, file_path, language, line_count, content
           FROM repository_files
           WHERE repository_id = $1 AND file_path = ANY($2)`,
          [repositoryId, unchunkedPaths]
        );
        for (const r of rawRes.rows) {
          const rawContent = String(r.content || '');
          const cappedContent = rawContent.slice(0, 12000);
          const cappedLines = cappedContent.split(/\r?\n/).length;
          pinnedChunks.push({
            id: `direct-${r.id}`,
            repositoryId,
            fileId: r.id,
            filePath: r.file_path,
            content: cappedContent,
            startLine: 1,
            endLine: cappedLines,
            language: r.language || 'javascript',
            symbolName: r.file_path.split('/').pop() || null,
            similarity: 0.98,
            matchSource: lexicalMatchReason.get(r.file_path) || 'filename',
          });
        }
      }
    }

    // 3. Merge pinned lexical chunks + vector chunks (dedup by filePath + startLine)
    const seenKeys = new Set<string>();
    const mergedChunks: RetrievedChunk[] = [];

    for (const chunk of pinnedChunks) {
      const key = `${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        mergedChunks.push(chunk);
      }
    }

    for (const chunk of vectorChunks) {
      if (mergedChunks.length >= topK) break;
      const key = `${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        mergedChunks.push(chunk);
      }
    }

    // 4. Retrieve AST symbols for all context files + combine with direct identifier matches
    const allContextFilePaths = Array.from(new Set(mergedChunks.map((c) => c.filePath)));
    let fileSymbols: Array<{ name: string; type: string; file_path: string; start_line: number; end_line: number }> = [];
    if (allContextFilePaths.length > 0) {
      const symRes = await query(
        `SELECT name, type, file_path, start_line, end_line
         FROM code_symbols
         WHERE repository_id = $1 AND file_path = ANY($2)
         ORDER BY start_line ASC
         LIMIT 50`,
        [repositoryId, allContextFilePaths]
      );
      fileSymbols = symRes.rows;
    }

    const symDedup = new Map<string, { name: string; type: string; file_path: string; start_line: number; end_line: number }>();
    for (const s of [...directSymbols, ...fileSymbols]) {
      const k = `${s.file_path}:${s.name}:${s.start_line}`;
      if (!symDedup.has(k)) symDedup.set(k, s);
    }
    const symbols = Array.from(symDedup.values()).slice(0, 50);

    // 5. Retrieve AST relationships connected to retrieved symbols/files (fallback to repo sample)
    let relationships: Array<{ source_symbol_id: string; target_symbol_id: string; relationship_type: string }> = [];
    const symbolNames = Array.from(new Set(symbols.map((s) => s.name))).slice(0, 15);
    if (symbolNames.length > 0) {
      const patterns = symbolNames.map((n) => `%:${n}`);
      const relRes = await query(
        `SELECT source_symbol_id, target_symbol_id, relationship_type
         FROM code_relationships
         WHERE repository_id = $1
           AND (source_symbol_id LIKE ANY($2) OR target_symbol_id LIKE ANY($2))
         LIMIT 40`,
        [repositoryId, patterns]
      );
      relationships = relRes.rows;
    }

    // 6. Build compact per-file evidence items & compute retrieval confidence
    const evidenceMap = new Map<
      string,
      {
        filePath: string;
        symbols: Set<string>;
        matchSource: 'filename' | 'symbol' | 'semantic' | 'relationship';
        similarity: number;
      }
    >();

    for (const c of mergedChunks) {
      const existing = evidenceMap.get(c.filePath);
      const source = c.matchSource || 'semantic';
      if (!existing) {
        evidenceMap.set(c.filePath, {
          filePath: c.filePath,
          symbols: new Set(c.symbolName ? [c.symbolName] : []),
          matchSource: source,
          similarity: c.similarity,
        });
      } else {
        if (c.symbolName) existing.symbols.add(c.symbolName);
        if (source === 'filename' || (source === 'symbol' && existing.matchSource === 'semantic')) {
          existing.matchSource = source;
        }
        existing.similarity = Math.max(existing.similarity, c.similarity);
      }
    }

    for (const s of symbols) {
      const entry = evidenceMap.get(s.file_path);
      if (entry) entry.symbols.add(s.name);
    }

    const evidenceItems = Array.from(evidenceMap.values()).map((e) => ({
      filePath: e.filePath,
      symbols: Array.from(e.symbols).slice(0, 6),
      matchSource: e.matchSource,
      similarity: Number(e.similarity.toFixed(3)),
    }));

    const maxVectorSimilarity = vectorChunks.reduce((m, c) => Math.max(m, c.similarity || 0), 0);
    let retrievalConfidence: 'high' | 'medium' | 'low' = 'low';
    if (lexicalMatchedPaths.length > 0 || (mergedChunks.length >= 3 && maxVectorSimilarity >= 0.45)) {
      retrievalConfidence = 'high';
    } else if (mergedChunks.length >= 2 && maxVectorSimilarity >= 0.25) {
      retrievalConfidence = 'medium';
    }

    return {
      chunks: mergedChunks,
      symbols,
      relationships,
      evidenceItems,
      retrievalConfidence,
      lexicalMatchedFiles: lexicalMatchedPaths,
      extractedSignals: {
        fileNames: signals.fileNames,
        identifiers: signals.identifiers,
      },
    };
  }

  /**
   * Answers a question about a repository using retrieved code chunks and generates real citations.
   */
  static async queryRepository(
    repositoryId: string,
    userQuery: string
  ): Promise<RagResponse> {
    let chunks = await this.retrieveRelevantChunks(repositoryId, userQuery, 6);

    // Fallback: If 0 vector chunks found, retrieve key repository files
    if (chunks.length === 0) {
      try {
        const filesRes = await query(
          `SELECT file_path, content, language, line_count
           FROM repository_files
           WHERE repository_id = $1
           ORDER BY line_count DESC
           LIMIT 5`,
          [repositoryId]
        );

        if (filesRes.rows.length > 0) {
          chunks = filesRes.rows.map((r, i) => ({
            id: `file-chunk-${i}`,
            repositoryId,
            fileId: `file-${i}`,
            filePath: r.file_path,
            content: r.content.slice(0, 2500),
            startLine: 1,
            endLine: Math.min(r.line_count || 50, 80),
            language: r.language || 'text',
            symbolName: r.file_path.split('/').pop() || null,
            similarity: 0.85,
          }));
        }
      } catch (_) {}
    }

    if (chunks.length === 0) {
      return {
        answer: "I couldn't find indexed files or code chunks for this repository yet. Please ensure the repository indexing has completed.",
        citations: [],
        confidenceScore: 0.2,
      };
    }

    const contextBlocks = chunks
      .map(
        (chunk, idx) =>
          `[Source Chunk ${idx + 1}]:\nFile: ${chunk.filePath}\nLines: ${chunk.startLine}-${chunk.endLine}\nLanguage: ${chunk.language}\nSymbol: ${chunk.symbolName || 'N/A'}\n\`\`\`${chunk.language.toLowerCase()}\n${chunk.content}\n\`\`\``
      )
      .join('\n\n');

    const prompt = `You are CodeGraph AI, an expert codebase and architecture intelligence assistant.
Answer the following question about the indexed repository based on the provided code chunks.

--- RETRIEVED REPOSITORY CONTEXT ---
${contextBlocks}

--- USER QUESTION ---
${userQuery}

--- INSTRUCTIONS ---
1. Base your answer strictly on the provided code chunks above.
2. Reference exact files and line ranges (e.g. \`src/main/java/... (lines 12-45)\`).
3. Explain the architecture, mechanics, annotations, or logic clearly with code references.
4. If asked for implementation steps or fixes, provide a structured breakdown.`;

    let answerText = '';
    const geminiKey = process.env.GEMINI_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    const isGemini = (geminiKey && !geminiKey.startsWith('sk-')) || (openaiKey && (openaiKey.startsWith('AIzaSy') || openaiKey.startsWith('AQ.')));
    const key = geminiKey || openaiKey || '';

    if (isGemini) {
      const preferredModel = process.env.LLM_MODEL || 'gemini-3.6-flash';
      const models = Array.from(new Set([
        preferredModel,
        'gemini-3.6-flash',
        'gemini-3.7-flash',
        'gemini-flash-latest',
        'gemini-3.5-flash',
      ]));

      for (const model of models) {
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
            }),
            signal: AbortSignal.timeout(20000),
          });
          if (res.ok) {
            const data = await res.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              answerText = text;
              break;
            }
          }
        } catch (_) {}
      }
    } else {
      try {
        const openai = new OpenAI({ apiKey: key });
        const completion = await openai.chat.completions.create({
          model: process.env.LLM_MODEL || 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: 'You are CodeGraph AI, an expert codebase assistant. Answer accurately with verified citations.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.2,
        });
        answerText = completion.choices[0]?.message?.content || '';
      } catch (_) {}
    }

    if (!answerText) {
      answerText = `Based on the repository source in \`${chunks[0]?.filePath}\`, this module defines ${chunks.map(c => c.symbolName || c.filePath).slice(0, 3).join(', ')}.`;
    }

    const citations = chunks.map((chunk) => {
      const filename = chunk.filePath.split('/').pop() || chunk.filePath;
      return {
        id: chunk.id,
        filename,
        path: chunk.filePath,
        lineRange: `L${chunk.startLine}-${chunk.endLine}`,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        language: chunk.language,
        similarity: Number(chunk.similarity.toFixed(4)),
        snippet: chunk.content,
      };
    });

    const avgConfidence =
      chunks.reduce((acc, c) => acc + c.similarity, 0) / (chunks.length || 1);

    return {
      answer: answerText,
      citations,
      confidenceScore: Math.min(Math.max(avgConfidence, 0.5), 0.99),
    };
  }

  /**
   * Alias for queryRepository
   */
  static async answerQuestion(repositoryId: string, userQuery: string): Promise<RagResponse> {
    return this.queryRepository(repositoryId, userQuery);
  }
}
