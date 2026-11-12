import { CodeAnalyzer, AnalysisResult, RepositoryFile, CodeSymbol, CodeRelationship, AnalysisError } from './types';
import { TypeScriptAnalyzer } from './analyzers/typeScriptAnalyzer';
import { GraphStorage } from './graphStorage';

export class CodeGraphEngine {
  private static analyzers: CodeAnalyzer[] = [
    new TypeScriptAnalyzer(),
  ];

  /**
   * Register a new custom code analyzer (e.g. for future Java / Python analyzers).
   */
  static registerAnalyzer(analyzer: CodeAnalyzer): void {
    this.analyzers.push(analyzer);
  }

  /**
   * Analyzes source files using matching AST analyzers.
   */
  static async analyze(repositoryId: string, files: RepositoryFile[]): Promise<AnalysisResult> {
    const allSymbols: CodeSymbol[] = [];
    const allRelationships: CodeRelationship[] = [];
    const allErrors: AnalysisError[] = [];

    for (const analyzer of this.analyzers) {
      const supportedFiles = files.filter((f) => analyzer.supports(f.filePath));
      if (supportedFiles.length === 0) continue;

      try {
        const result = await analyzer.analyze(repositoryId, supportedFiles);
        allSymbols.push(...result.symbols);
        allRelationships.push(...result.relationships);
        allErrors.push(...result.errors);
      } catch (err: any) {
        console.error(`[CodeGraphEngine] Error in ${analyzer.name}:`, err);
        allErrors.push({
          filePath: 'analyzer-execution',
          message: `${analyzer.name} failed: ${err?.message || err}`,
          stack: err?.stack,
        });
      }
    }

    // Log AST Analysis Breakdown Telemetry
    const extCounts = new Map<string, number>();
    const dirCounts = new Map<string, number>();
    const fileSymbolCounts = new Map<string, number>();

    for (const sym of allSymbols) {
      const ext = sym.filePath.includes('.') ? sym.filePath.substring(sym.filePath.lastIndexOf('.')) : 'unknown';
      extCounts.set(ext, (extCounts.get(ext) || 0) + 1);

      const parts = sym.filePath.replace(/\\/g, '/').split('/');
      const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : 'root';
      dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1);

      fileSymbolCounts.set(sym.filePath, (fileSymbolCounts.get(sym.filePath) || 0) + 1);
    }

    const topFiles = Array.from(fileSymbolCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    console.log(`[CodeGraphEngine Telemetry] Files: ${files.length} analyzed | Symbols: ${allSymbols.length} extracted | Relationships: ${allRelationships.length}`);
    console.log(`[CodeGraphEngine Telemetry] By Ext:`, Object.fromEntries(extCounts));
    console.log(`[CodeGraphEngine Telemetry] Top Files Producing Symbols:`, topFiles.map(([f, c]) => `${f} (${c})`));

    return {
      symbols: allSymbols,
      relationships: allRelationships,
      errors: allErrors,
    };
  }

  /**
   * Analyzes repository files and atomically persists graph data upon validation.
   * Fails gracefully without throwing fatal errors to caller if requested.
   */
  static async analyzeAndStore(repositoryId: string, files: RepositoryFile[]): Promise<AnalysisResult> {
    // 1. Run AST Analysis
    const result = await this.analyze(repositoryId, files);

    // 2. Persist to Database atomically (analyze -> validate -> replace)
    if (result.symbols.length > 0 || result.relationships.length > 0) {
      await GraphStorage.replaceGraphData(repositoryId, result.symbols, result.relationships);
    }

    return result;
  }
}
