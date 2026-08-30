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

// ============================================================================
// Simple in-memory vector store (production would use SQLite FTS5)
// ============================================================================

export class VectorStore {
  private records: Map<string, VectorRecord> = new Map();
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

  async get(id: string): Promise<VectorRecord | null> {
    return this.records.get(id) ?? null;
  }

  async delete(id: string): Promise<boolean> {
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
      // Fallback: generate simple hash-based pseudo-embedding
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
   * Generate pseudo-embedding from text content.
   * Used as fallback when no embedding provider is available.
   */
  generatePseudoEmbedding(content: string): number[] {
    const embedding = new Array(this.dimension).fill(0);
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) - hash) + content.charCodeAt(i);
      hash = hash & hash;
    }

    // Seed random with hash for reproducibility
    const seed = Math.abs(hash);
    for (let i = 0; i < this.dimension; i++) {
      // Simple pseudo-random based on content
      const charCode = content.charCodeAt(i % content.length) || 1;
      embedding[i] = Math.sin(seed * (i + 1) * charCode) * 0.5 + 0.5;
    }

    // Normalize
    const magnitude = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    if (magnitude > 0) {
      for (let i = 0; i < embedding.length; i++) {
        embedding[i] /= magnitude;
      }
    }

    return embedding;
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

  // ========== Hybrid Search ==========

  async hybridSearch(
    options: HybridSearchOptions,
    getTextScore: (content: string, query: string) => number = bm25Score
  ): Promise<SearchResult[]> {
    const { query, topK, semanticWeight, bm25Weight, entityBoostWeight, minScore = 0.1 } = options;

    // Get query embedding if not provided
    let queryEmbedding = options.queryEmbedding;
    if (!queryEmbedding) {
      queryEmbedding = await this.embedContent(query);
    }

    // Semantic search
    const semanticResults = await this.searchByVector(queryEmbedding, topK * 2, 0.0);

    // BM25 search (simple in-memory version)
    const bm25Results = this.bm25Search(query, topK * 2);

    // Entity boost (extract entities and boost matches)
    const entities = this.extractEntities(query);
    const entityBoostResults = this.entityBoostSearch(entities, topK * 2);

    // Merge scores
    const scoreMap = new Map<string, SearchResult>();

    for (const result of semanticResults) {
      const semanticScore = result.score * semanticWeight;
      scoreMap.set(result.id, {
        id: result.id,
        content: result.content,
        score: semanticScore,
        metadata: result.metadata,
      });
    }

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

    // Filter and sort
    const finalResults = Array.from(scoreMap.values())
      .filter(r => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return finalResults;
  }

  // ========== BM25 (in-memory simplified) ==========

  private bm25Search(query: string, topK: number): SearchResult[] {
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
          // Simplified IDF (in production, calculate from corpus)
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

  // ========== Entity Extraction & Boost ==========

  private extractEntities(query: string): string[] {
    // Simple entity extraction (in production use NER)
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

    return [...new Set(entities)];
  }

  private entityBoostSearch(entities: string[], topK: number): SearchResult[] {
    if (entities.length === 0) return [];

    const results: SearchResult[] = [];

    for (const record of this.records.values()) {
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

  async getAll(): Promise<VectorRecord[]> {
    return Array.from(this.records.values());
  }

  async count(): Promise<number> {
    return this.records.size;
  }

  async clear(): Promise<void> {
    this.records.clear();
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
