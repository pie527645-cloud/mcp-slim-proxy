import type { IndexedTool, ToolSearchHit } from './types.js';

const BM25_K1 = 1.5;
const BM25_B = 0.75;

export function extractOneLineSummary(description: string | undefined, fallbackId: string): string {
  if (!description) {
    return `Downstream tool ${fallbackId}.`;
  }
  const lines = description.split(/\r?\n/);
  let firstNonEmpty = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      firstNonEmpty = trimmed;
      break;
    }
  }
  if (firstNonEmpty.length === 0) {
    return `Downstream tool ${fallbackId}.`;
  }
  const normalized = firstNonEmpty.replace(/\s+/g, ' ');
  if (normalized.length <= 140) {
    return normalized;
  }
  return `${normalized.slice(0, 137).trimEnd()}...`;
}

export function extractParameterNames(inputSchema: Record<string, unknown> | undefined): string[] {
  if (!inputSchema || typeof inputSchema !== 'object') {
    return [];
  }
  const props = inputSchema['properties'];
  if (!props || typeof props !== 'object' || Array.isArray(props)) {
    return [];
  }
  return Object.keys(props as Record<string, unknown>);
}

export function tokenizeForSearch(input: string): string[] {
  if (!input) {
    return [];
  }
  // Split camelCase transitions (e.g. createPullRequest -> create Pull Request) linearly
  let expanded = '';
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    const prev = i > 0 ? input.charCodeAt(i - 1) : 0;
    const isUpper = ch >= 65 && ch <= 90;
    const prevIsLowerOrDigit = (prev >= 97 && prev <= 122) || (prev >= 48 && prev <= 57);
    if (i > 0 && isUpper && prevIsLowerOrDigit) {
      expanded += ' ';
    }
    expanded += input.charAt(i);
  }

  const lower = expanded.toLowerCase();
  const tokens: string[] = [];
  let current = '';
  for (let i = 0; i < lower.length; i += 1) {
    const code = lower.charCodeAt(i);
    const isAlphaNum = (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
    if (isAlphaNum) {
      current += lower.charAt(i);
    } else if (current.length > 0) {
      tokens.push(current);
      current = '';
    }
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

interface IndexedDocument {
  tool: IndexedTool;
  termFreqs: Map<string, number>;
  docLength: number;
  lowerHaystack: string;
}

export class ToolSearchIndex {
  private readonly docs: IndexedDocument[] = [];
  private readonly docFreqs = new Map<string, number>();
  private readonly healthyById = new Map<string, IndexedTool>();
  private readonly allById = new Map<string, IndexedTool>();
  private readonly avgDocLength: number;

  constructor(tools: readonly IndexedTool[]) {
    let totalDocLength = 0;

    for (const tool of tools) {
      this.allById.set(tool.toolId, tool);
      if (tool.quarantined) {
        continue;
      }
      this.healthyById.set(tool.toolId, tool);

      const termFreqs = new Map<string, number>();
      const addTokens = (tokens: readonly string[], weight: number): void => {
        for (const tok of tokens) {
          termFreqs.set(tok, (termFreqs.get(tok) ?? 0) + weight);
        }
      };

      addTokens(tokenizeForSearch(tool.serverName), 3.0);
      addTokens(tokenizeForSearch(tool.toolName), 3.5);
      for (const param of tool.parameterNames) {
        addTokens(tokenizeForSearch(param), 2.0);
      }
      addTokens(tokenizeForSearch(tool.summary), 1.25);
      addTokens(tokenizeForSearch(tool.description), 0.75);

      let docLength = 0;
      for (const [term, freq] of termFreqs.entries()) {
        docLength += freq;
        this.docFreqs.set(term, (this.docFreqs.get(term) ?? 0) + 1);
      }
      totalDocLength += docLength;

      const lowerHaystack = `${tool.toolId} ${tool.parameterNames.join(' ')} ${tool.summary}`.toLowerCase();
      this.docs.push({
        tool,
        termFreqs,
        docLength,
        lowerHaystack,
      });
    }

    this.avgDocLength = this.docs.length > 0 ? totalDocLength / this.docs.length : 1;
  }

  public getHealthyCount(): number {
    return this.healthyById.size;
  }

  public getToolOrThrow(toolId: string): IndexedTool {
    const found = this.allById.get(toolId);
    if (!found) {
      throw new Error(`Unknown tool "${toolId}". Run search_tools to discover valid healthy tool IDs.`);
    }
    if (found.quarantined) {
      const reasons = found.findings.map((f) => `[${f.severity}:${f.category}] ${f.message}`).join('; ');
      throw new Error(
        `Tool "${toolId}" is quarantined by the poisoning firewall and cannot be accessed (${reasons}).`
      );
    }
    return found;
  }

  public search(query: string, options?: { server?: string; limit?: number }): ToolSearchHit[] {
    const rawLimit = options?.limit ?? 10;
    const limit = Math.max(1, Math.min(50, Math.floor(rawLimit)));
    const serverFilter = options?.server?.trim();

    const candidates = serverFilter
      ? this.docs.filter((d) => d.tool.serverName === serverFilter)
      : this.docs;

    if (candidates.length === 0) {
      return [];
    }

    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0 || trimmedQuery === '*') {
      return [...candidates]
        .sort((a, b) => a.tool.toolId.localeCompare(b.tool.toolId))
        .slice(0, limit)
        .map((d) => ({
          toolId: d.tool.toolId,
          server: d.tool.serverName,
          name: d.tool.toolName,
          parameters: d.tool.parameterNames,
          summary: d.tool.summary,
          score: 0,
        }));
    }

    const queryTokens = Array.from(new Set(tokenizeForSearch(trimmedQuery)));
    if (queryTokens.length === 0) {
      return [];
    }

    const totalDocs = Math.max(1, this.docs.length);
    const scored: ToolSearchHit[] = [];

    for (const doc of candidates) {
      let score = 0;
      for (const qTerm of queryTokens) {
        const tf = doc.termFreqs.get(qTerm) ?? 0;
        if (tf > 0) {
          const df = this.docFreqs.get(qTerm) ?? 1;
          const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
          const norm = tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.docLength / this.avgDocLength));
          score += idf * ((tf * (BM25_K1 + 1)) / norm);
        } else if (qTerm.length >= 3 && doc.lowerHaystack.includes(qTerm)) {
          score += 0.35;
        }
      }

      if (doc.tool.toolId.toLowerCase() === trimmedQuery.toLowerCase()) {
        score += 5.0;
      }

      if (score > 0) {
        scored.push({
          toolId: doc.tool.toolId,
          server: doc.tool.serverName,
          name: doc.tool.toolName,
          parameters: doc.tool.parameterNames,
          summary: doc.tool.summary,
          score: Math.round(score * 10000) / 10000,
        });
      }
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.toolId.localeCompare(b.toolId);
    });

    return scored.slice(0, limit);
  }
}
