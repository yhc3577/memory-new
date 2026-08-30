/**
 * Vector Store - Embedding-based semantic search
 *
 * Uses OpenClaw's embedding provider for L1 semantic search.
 * Supports hybrid search: vector + BM25 + entity boost.
 */

import type { EmbeddingProvider } from "openclaw/plugin-sdk/embedding-providers";

export interface VectorRecord {
  id: string;
  content: string;
  embedding: number[];
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface SearchResult {
  id: string;
  content: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface HybridSearchOptions {
  query: string;
  queryEmbedding?: number[];
  topK: number;
  semanticWeight: number;
  bm25Weight: number;
  entityBoostWeight: number;
  minScore?: number;
}

/**
 * Text record for BM25-only search (without embedding)
 */
export interface TextRecord {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Simple in-memory vector store (production would use SQLite FTS5)
// ============================================================================

export class VectorStore {
  private records: Map<string, VectorRecord> = new Map();
  private textRecords: Map<string, TextRecord> = new Map();  // For BM25-only mode
  private embeddingProvider: EmbeddingProvider | null = null;
  private dimension: number = 384;

  constructor(dimension: number = 384) {
    this.dimension = dimension;
  }

  setEmbeddingProvider(provider: EmbeddingProvider): void {
    this.embeddingProvider = provider;
  }

  // ========== Record Operations ==========

  async add(record: Omit<VectorRecord, "createdAt">): Promise<VectorRecord> {
    const fullRecord: VectorRecord = {
      ...record,
      createdAt: Date.now(),
    };
    this.records.set(record.id, fullRecord);
    return fullRecord;
  }

  /**
   * Add a text-only record for BM25 search (without embedding)
   */
  async addTextRecord(record: TextRecord): Promise<void> {
    this.textRecords.set(record.id, record);
  }

  /**
   * Bulk add text records for BM25 search
   */
  async addTextRecords(records: TextRecord[]): Promise<void> {
    for (const record of records) {
      this.textRecords.set(record.id, record);
    }
  }

  async get(id: string): Promise<VectorRecord | null> {
    return this.records.get(id) ?? null;
  }

  async delete(id: string): Promise<boolean> {
    this.textRecords.delete(id);
    return this.records.delete(id);
  }

  async update(id: string, updates: Partial<VectorRecord>): Promise<VectorRecord | null> {
    const existing = this.records.get(id);
    if (!existing) return null;

    const updated = { ...existing, ...updates };
    this.records.set(id, updated);
    return updated;
  }

  // ========== Embedding Operations ==========

  async embedContent(content: string): Promise<number[]> {
    if (!this.embeddingProvider) {
      // Fallback: generate deterministic pseudo-embedding
      return this.fallbackEmbed(content);
    }

    try {
      const embedding = await this.embeddingProvider.embed(content, { inputType: "query" });
      return embedding;
    } catch (error) {
      console.error("Embedding failed, using fallback:", error);
      return this.fallbackEmbed(content);
    }
  }

  async embedBatch(contents: string[]): Promise<number[][]> {
    if (!this.embeddingProvider) {
      return contents.map(c => this.fallbackEmbed(c));
    }

    try {
      return await this.embeddingProvider.embedBatch(contents, { inputType: "document" });
    } catch (error) {
      console.error("Batch embedding failed, using fallback:", error);
      return contents.map(c => this.fallbackEmbed(c));
    }
  }

  // Fallback pseudo-embedding using hash (for testing without API)
  private fallbackEmbed(content: string): number[] {
    return this.generatePseudoEmbedding(content);
  }

  /**
   * Generate deterministic pseudo-embedding from text content.
   * Uses character-level features for better consistency.
   */
  generatePseudoEmbedding(content: string): number[] {
    const embedding = new Array(this.dimension).fill(0);
    const normalizedContent = content.toLowerCase().trim();

    // Use multiple hash functions for different dimensions
    for (let i = 0; i < this.dimension; i++) {
      // Create a deterministic value based on content characters
      let value = 0;
      for (let j = 0; j < normalizedContent.length; j++) {
        const charCode = normalizedContent.charCodeAt(j);
        // Mix character with position and dimension index
        value += Math.sin(charCode * (j + 1) * (i + 1)) * (j + 1);
      }
      // Normalize to [0, 1]
      embedding[i] = (Math.sin(value) + 1) / 2;
    }

    // L2 normalize
    this.normalizeVector(embedding);
    return embedding;
  }

  private normalizeVector(vec: number[]): void {
    const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    if (magnitude > 0) {
      for (let i = 0; i < vec.length; i++) {
        vec[i] /= magnitude;
      }
    }
  }

  // ========== Vector Search ==========

  async searchByVector(
    queryEmbedding: number[],
    topK: number,
    minScore: number = 0.0
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    for (const record of this.records.values()) {
      if (record.embedding.length !== queryEmbedding.length) continue;

      const score = this.cosineSimilarity(queryEmbedding, record.embedding);
      if (score >= minScore) {
        results.push({
          id: record.id,
          content: record.content,
          score,
          metadata: record.metadata,
        });
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  // ========== Hybrid Search (with text records fallback) ==========

  async hybridSearch(
    options: HybridSearchOptions,
    getTextScore: (content: string, query: string) => number = bm25Score
  ): Promise<SearchResult[]> {
    const {
      query,
      topK,
      semanticWeight,
      bm25Weight,
      entityBoostWeight,
      minScore = 0.1
    } = options;

    // Get query embedding if not provided
    let queryEmbedding = options.queryEmbedding;
    if (!queryEmbedding) {
      queryEmbedding = await this.embedContent(query);
    }

    // Semantic search (only if we have vector records)
    let semanticResults: SearchResult[] = [];
    if (this.records.size > 0) {
      semanticResults = await this.searchByVector(queryEmbedding, topK * 2, 0.0);
    }

    // BM25 search - works on both vector records and text records
    const bm25Results = this.bm25Search(query, topK * 2);

    // Entity boost
    const entities = this.extractEntities(query);
    const entityBoostResults = this.entityBoostSearch(entities, topK * 2);

    // Fuzzy and substring search for fallback
    const fuzzyResults = this.fuzzySearch(query, topK * 2);
    const substringResults = this.substringSearch(query, topK * 2);

    // Merge scores
    const scoreMap = new Map<string, SearchResult>();

    // Add semantic results
    for (const result of semanticResults) {
      const semanticScore = result.score * semanticWeight;
      scoreMap.set(result.id, {
        id: result.id,
        content: result.content,
        score: semanticScore,
        metadata: result.metadata,
      });
    }

    // Add BM25 results
    for (const result of bm25Results) {
      const existing = scoreMap.get(result.id);
      const bm25Contribution = result.score * bm25Weight;
      if (existing) {
        existing.score += bm25Contribution;
      } else {
        scoreMap.set(result.id, {
          id: result.id,
          content: result.content,
          score: bm25Contribution,
          metadata: result.metadata,
        });
      }
    }

    // Add entity boost
    for (const result of entityBoostResults) {
      const existing = scoreMap.get(result.id);
      const boostContribution = result.score * entityBoostWeight;
      if (existing) {
        existing.score += boostContribution;
      } else {
        scoreMap.set(result.id, {
          id: result.id,
          content: result.content,
          score: boostContribution,
          metadata: result.metadata,
        });
      }
    }

    // Add fuzzy results (with lower weight)
    const fuzzyWeight = 0.15;
    for (const result of fuzzyResults) {
      const existing = scoreMap.get(result.id);
      const fuzzyContribution = result.score * fuzzyWeight;
      if (existing) {
        existing.score += fuzzyContribution;
      } else {
        scoreMap.set(result.id, {
          id: result.id,
          content: result.content,
          score: fuzzyContribution,
          metadata: result.metadata,
        });
      }
    }

    // Add substring results (with lower weight)
    const substringWeight = 0.1;
    for (const result of substringResults) {
      const existing = scoreMap.get(result.id);
      const substringContribution = result.score * substringWeight;
      if (existing) {
        existing.score += substringContribution;
      } else {
        scoreMap.set(result.id, {
          id: result.id,
          content: result.content,
          score: substringContribution,
          metadata: result.metadata,
        });
      }
    }

    // Filter and sort
    const finalResults = Array.from(scoreMap.values())
      .filter(r => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return finalResults;
  }

  // ========== Pure BM25 Search (on text records) ==========

  /**
   * Pure BM25 search that works without embeddings.
   * Uses textRecords for matching.
   */
  searchBM25(query: string, topK: number = 10): SearchResult[] {
    const queryTerms = this.tokenize(query);
    if (queryTerms.length === 0) return [];

    const results: SearchResult[] = [];
    const avgDocLen = this.getAverageTextDocLength();
    const k1 = 1.5;
    const b = 0.75;

    // Calculate IDF for each term
    const idfMap = new Map<string, number>();
    const docFreq = new Map<string, number>();

    for (const term of queryTerms) {
      let count = 0;
      for (const record of this.textRecords.values()) {
        const terms = this.tokenize(record.content);
        if (terms.includes(term)) count++;
      }
      docFreq.set(term, count);
      // IDF formula: log((N - n + 0.5) / (n + 0.5))
      const N = this.textRecords.size || 1;
      const n = count || 1;
      idfMap.set(term, Math.log((N - n + 0.5) / (n + 0.5) + 1));
    }

    for (const record of this.textRecords.values()) {
      const terms = this.tokenize(record.content);
      let score = 0;

      for (const term of queryTerms) {
        const tf = terms.filter(t => t === term).length;
        if (tf > 0) {
          const idf = idfMap.get(term) || 0;
          const docLen = terms.length;
          const numerator = tf * (k1 + 1);
          const denominator = tf + k1 * (1 - b + b * (docLen / avgDocLen));
          score += idf * (numerator / denominator);
        }
      }

      if (score > 0) {
        results.push({
          id: record.id,
          content: record.content,
          score,
          metadata: record.metadata || {},
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  // ========== BM25 (in-memory simplified) ==========

  private bm25Search(query: string, topK: number): SearchResult[] {
    // Try text records first (BM25)
    if (this.textRecords.size > 0) {
      return this.searchBM25(query, topK);
    }

    // Fallback to vector records
    const queryTerms = query.toLowerCase().split(/\s+/);
    const results: SearchResult[] = [];
    const avgDocLen = this.getAverageDocLength();
    const k1 = 1.5;
    const b = 0.75;

    for (const record of this.records.values()) {
      const terms = record.content.toLowerCase().split(/\s+/);
      let score = 0;

      for (const term of queryTerms) {
        const tf = terms.filter(t => t === term).length;
        if (tf > 0) {
          const idf = Math.log((this.records.size + 1) / 2);
          const docLen = terms.length;
          const numerator = tf * (k1 + 1);
          const denominator = tf + k1 * (1 - b + b * (docLen / avgDocLen));
          score += idf * (numerator / denominator);
        }
      }

      if (score > 0) {
        results.push({
          id: record.id,
          content: record.content,
          score,
          metadata: record.metadata,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  private getAverageDocLength(): number {
    if (this.records.size === 0) return 1;
    let total = 0;
    for (const record of this.records.values()) {
      total += record.content.split(/\s+/).length;
    }
    return total / this.records.size;
  }

  private getAverageTextDocLength(): number {
    if (this.textRecords.size === 0) return 1;
    let total = 0;
    for (const record of this.textRecords.values()) {
      total += this.tokenize(record.content).length;
    }
    return total / this.textRecords.size;
  }

  // ========== Entity Extraction & Boost ==========

  private extractEntities(query: string): string[] {
    const entities: string[] = [];

    // Capitalized words (potential entities)
    const capitalizedPattern = /[A-Z][a-z]+/g;
    let match;
    while ((match = capitalizedPattern.exec(query)) !== null) {
      entities.push(match[0].toLowerCase());
    }

    // Quoted strings
    const quotedPattern = /"([^"]+)"|'([^']+)'/g;
    while ((match = quotedPattern.exec(query)) !== null) {
      const entity = match[1] || match[2];
      entities.push(entity.toLowerCase());
    }

    // Chinese entities (continuous Chinese characters)
    const chinesePattern = /[一-龥]{2,}/g;
    while ((match = chinesePattern.exec(query)) !== null) {
      entities.push(match[0].toLowerCase());
    }

    return [...new Set(entities)];
  }

  private entityBoostSearch(entities: string[], topK: number): SearchResult[] {
    if (entities.length === 0) return [];

    // Search in both records and textRecords
    const allRecords = [
      ...Array.from(this.records.values()).map(r => ({ id: r.id, content: r.content, metadata: r.metadata })),
      ...Array.from(this.textRecords.values()).map(r => ({ id: r.id, content: r.content, metadata: r.metadata || {} })),
    ];

    const results: SearchResult[] = [];

    for (const record of allRecords) {
      const content = record.content.toLowerCase();
      let matchCount = 0;

      for (const entity of entities) {
        if (content.includes(entity)) {
          matchCount++;
        }
      }

      if (matchCount > 0) {
        // Score based on how many entities matched
        const score = matchCount / entities.length;
        results.push({
          id: record.id,
          content: record.content,
          score,
          metadata: record.metadata,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  // ========== Utilities ==========

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;

    return dotProduct / denominator;
  }

  /**
   * Simple tokenization supporting both English and Chinese
   */
  private tokenize(text: string): string[] {
    // Split on whitespace and punctuation, keep Chinese characters together
    return text.toLowerCase()
      .split(/[\s,.!?;:'"(){}[\]—–-]+/)
      .filter(t => t.length > 0);
  }

  async getAll(): Promise<VectorRecord[]> {
    return Array.from(this.records.values());
  }

  async count(): Promise<number> {
    return this.records.size + this.textRecords.size;
  }

  async clear(): Promise<void> {
    this.records.clear();
    this.textRecords.clear();
  }

  /**
   * Sync text records from L1 records (for BM25 search)
   */
  syncFromL1Records(records: Array<{ id: string; content: string; metadata?: Record<string, unknown> }>): void {
    for (const record of records) {
      this.textRecords.set(record.id, {
        id: record.id,
        content: record.content,
        metadata: record.metadata,
      });
    }
  }

  // ========== Query Expansion & Fuzzy Matching ==========

  /**
   * Expand query with synonyms and related terms (simple version)
   */
  expandQuery(query: string): string[] {
    const expansions: string[] = [query];
    const terms = this.tokenize(query);

    // Common Chinese/English synonym mappings
    const synonyms: Record<string, string[]> = {
      // Chinese
      "项目": ["项目", "工程", "case", "project"],
      "讨论": ["讨论", "聊", "聊了", "谈到", "discussed"],
      "架构": ["架构", "结构", "框架", "architecture", "framework"],
      "决定": ["决定", "确定", "敲定", "decided", "determined"],
      "会议": ["会议", "会", "开会", "meeting"],
      "下午": ["下午", "午后", "下午茶"],
      "三点": ["三点", "15点", "下午三点"],
      // English
      "project": ["project", "case", "work"],
      "discuss": ["discuss", "talk", "talked"],
      "meeting": ["meeting", "call", "conference"],
    };

    for (const term of terms) {
      const syns = synonyms[term.toLowerCase()];
      if (syns) {
        expansions.push(...syns);
      }
    }

    return [...new Set(expansions)];
  }

  /**
   * Fuzzy search with edit distance matching
   */
  fuzzySearch(query: string, topK: number = 10, maxEditDistance: number = 2): SearchResult[] {
    const results: SearchResult[] = [];
    const queryTerms = this.tokenize(query);

    for (const record of this.textRecords.values()) {
      const recordTerms = this.tokenize(record.content);
      let matchScore = 0;

      for (const qt of queryTerms) {
        for (const rt of recordTerms) {
          const distance = this.levenshteinDistance(qt, rt);
          if (distance <= maxEditDistance) {
            // Score based on how close the match is
            matchScore += 1 - (distance / Math.max(qt.length, rt.length));
          }
        }
      }

      if (matchScore > 0) {
        results.push({
          id: record.id,
          content: record.content,
          score: matchScore / queryTerms.length,  // Normalize by query length
          metadata: record.metadata || {},
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  /**
   * Calculate Levenshtein edit distance between two strings
   */
  private levenshteinDistance(a: string, b: string): number {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix: number[][] = [];

    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1,     // insertion
            matrix[i - 1][j] + 1      // deletion
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }

  /**
   * Substring search for partial matches
   */
  substringSearch(query: string, topK: number = 10): SearchResult[] {
    const results: SearchResult[] = [];
    const queryLower = query.toLowerCase();

    for (const record of this.textRecords.values()) {
      const contentLower = record.content.toLowerCase();
      const index = contentLower.indexOf(queryLower);

      if (index !== -1) {
        // Score based on position (earlier is better) and length ratio
        const positionScore = 1 - (index / contentLower.length);
        const lengthRatio = queryLower.length / contentLower.length;
        const score = positionScore * 0.7 + lengthRatio * 0.3;

        results.push({
          id: record.id,
          content: record.content,
          score,
          metadata: record.metadata || {},
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }
}

// BM25 score helper (exposed for external use)
export function bm25Score(content: string, query: string): number {
  const queryTerms = query.toLowerCase().split(/\s+/);
  const terms = content.toLowerCase().split(/\s+/);
  let score = 0;

  for (const term of queryTerms) {
    const tf = terms.filter(t => t === term).length;
    if (tf > 0) {
      // Simplified BM25
      score += 1 + Math.log(1 + tf);
    }
  }

  return score;
}
