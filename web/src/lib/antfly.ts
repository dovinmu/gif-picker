// Antfly API client for GIF search

const API_BASE = '/api/v1';
const TERMITE_BASE = '/termite'; // Proxied to fixed termite (localhost:11434)

export interface TableConfig {
  name: string;
  label: string;
  searchMode: 'semantic' | 'clip_vector';
}

export const TABLES: TableConfig[] = [
  { name: 'tgif_gifs_text', label: 'Text Descriptions', searchMode: 'semantic' },
  { name: 'tgif_gifs', label: 'CLIP Embeddings', searchMode: 'clip_vector' },
];

export interface GifResult {
  id: string;
  score: number;
  gif_url: string;
  description: string;
  tumblr_id?: string;
  original_description?: string;
  literal?: string;
  mood?: string;
  action?: string | string[];
  context?: string;
  source?: string;
  tags?: string[];
  attribution?: string;
  combined_text?: string;
  rank?: number;
  [key: string]: unknown; // allow arbitrary extra fields from API
}

export interface SearchResponse {
  results: GifResult[];
  total: number;
}

// Embed query text using fixed termite (CLIP with EOS pooling fix)
async function embedQuery(text: string): Promise<number[]> {
  const response = await fetch(`${TERMITE_BASE}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'openai/clip-vit-base-patch32',
      input: [{ type: 'text', text }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Termite embed failed: ${response.statusText}`);
  }

  // Parse binary response: uint64 numVectors, uint64 dimension, float32[] values
  const buffer = await response.arrayBuffer();
  const view = new DataView(buffer);

  // Skip numVectors (8 bytes), read dimension (8 bytes)
  const dimension = Number(view.getBigUint64(8, true));

  // Read float32 values starting at byte 16
  const embedding: number[] = [];
  for (let i = 0; i < dimension; i++) {
    embedding.push(view.getFloat32(16 + i * 4, true));
  }

  return embedding;
}

export async function getGifById(tableName: string, id: string): Promise<GifResult | null> {
  try {
    const response = await fetch(`${API_BASE}/tables/${tableName}/docs/${id}`);
    if (!response.ok) return null;
    const data = await response.json();
    const source = data.source ?? data._source ?? data;
    if (isRemovedGif(source)) return null;
    return {
      ...source,
      id: data.id ?? data._id ?? id,
      score: 0,
      gif_url: source.gif_url ?? '',
      description: source.description ?? source.original_description ?? source.combined_text ?? '',
    };
  } catch {
    return null;
  }
}

// Detect GIFs removed by Tumblr (copyright/guideline violations)
function isRemovedGif(source: Record<string, any>): boolean {
  const fields = [source.literal, source.description, source.combined_text];
  return fields.some(f => typeof f === 'string' && f.toLowerCase().includes('content has been removed'));
}

// Google-style query parsing: "quoted phrases", tag:X, -tag:X, and loose terms
interface ParsedQuery {
  phrases: string[];    // "quoted phrases" → match_phrase
  looseText: string;    // unquoted terms → match + semantic
  tags: string[];
  negativeTags: string[];
}

function parseQuery(raw: string): ParsedQuery {
  const tags: string[] = [];
  const negativeTags: string[] = [];
  const phrases: string[] = [];

  // Strip -tag:"quoted" and -tag:word first
  let remaining = raw
    .replace(/-tag:"([^"]+)"/g, (_, tag) => {
      negativeTags.push(tag.toLowerCase());
      return '';
    })
    .replace(/-tag:(\S+)/g, (_, tag) => {
      negativeTags.push(tag.toLowerCase());
      return '';
    })
    // Then tag:"quoted" and tag:word
    .replace(/tag:"([^"]+)"/g, (_, tag) => {
      tags.push(tag.toLowerCase());
      return '';
    })
    .replace(/tag:(\S+)/g, (_, tag) => {
      tags.push(tag.toLowerCase());
      return '';
    });

  // Extract "quoted phrases"
  remaining = remaining.replace(/"([^"]+)"/g, (_, phrase) => {
    phrases.push(phrase.trim());
    return '';
  });

  const looseText = remaining.trim();
  return { phrases, looseText, tags, negativeTags };
}

// Build the full_text_search value from parsed query components
function buildFullTextSearch(phrases: string[], looseText: string): Record<string, unknown> | undefined {
  const parts: Record<string, unknown>[] = [];

  for (const phrase of phrases) {
    parts.push({ match_phrase: phrase, field: 'combined_text' });
  }
  if (looseText) {
    parts.push({ match: looseText, field: 'combined_text' });
  }

  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return { conjuncts: parts };
}

// Build exclusion_query from negative tags and excluded attributions
function buildExclusionQuery(negativeTags: string[], excludedAttributions?: Set<string>): Record<string, unknown> | undefined {
  const parts: string[] = [];

  for (const tag of negativeTags) {
    // Quote values to handle multi-word tags like "Live Leak"
    parts.push(`tags:"${tag}"`);
  }
  if (excludedAttributions) {
    for (const attr of excludedAttributions) {
      parts.push(`attribution:"${attr}"`);
    }
  }

  if (parts.length === 0) return undefined;
  return { query: parts.join(' OR ') };
}

export async function searchGifs(
  query: string,
  table: TableConfig,
  limit: number = 50,
  excludedAttributions?: Set<string>,
): Promise<SearchResponse> {
  let body: Record<string, unknown>;
  const { phrases, looseText, tags, negativeTags } = parseQuery(query);

  if (table.searchMode === 'semantic') {
    body = { limit };

    const fts = buildFullTextSearch(phrases, looseText);
    const hasTextSearch = !!(fts || looseText);

    if (fts) {
      body.full_text_search = fts;
    }

    // Only include semantic search when there are unquoted terms
    if (looseText) {
      body.semantic_search = looseText;
      body.indexes = ['embeddings'];
      if (fts) {
        body.merge_strategy = 'rrf';
      }
    }

    // Apply positive tag filter
    // Use match_phrase for multi-word tags (Bleve tokenizes "Live Leak" into ["live","leak"],
    // so term:"live leak" won't match — match_phrase finds adjacent tokens in order)
    if (tags.length > 0) {
      const tagQueries = tags.map(t =>
        t.includes(' ')
          ? { match_phrase: t, field: 'tags' }
          : { term: t, field: 'tags' }
      );
      const tagQuery = tagQueries.length === 1 ? tagQueries[0] : { conjuncts: tagQueries };

      if (hasTextSearch) {
        // Tags as a filter on top of text/semantic search
        body.filter_query = tagQuery;
      } else {
        // Tag-only: use as the primary full-text search (no semantic)
        body.full_text_search = tagQuery;
      }
    }

    // Apply negative tags + attribution exclusions
    const exclusion = buildExclusionQuery(negativeTags, excludedAttributions);
    if (exclusion) {
      body.exclusion_query = exclusion;
    }
  } else {
    // CLIP mode: embed query client-side via fixed termite
    const queryVector = await embedQuery(looseText || [...phrases, query].join(' '));
    body = {
      vector_search: {
        index: 'embeddings',
        vector: queryVector,
      },
      limit,
    };
  }

  const response = await fetch(`${API_BASE}/tables/${table.name}/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Search failed: ${response.statusText}`);
  }

  const data = await response.json();

  // Debug: log raw response in development
  if (import.meta.env.DEV) {
    console.log('Antfly raw response:', JSON.stringify(data, null, 2).slice(0, 1000));
  }

  // Check for error in response
  const firstResponse = data.responses?.[0];
  if (firstResponse?.error) {
    throw new Error(firstResponse.error);
  }

  // Transform Antfly response to our format
  const hits = firstResponse?.hits?.hits ?? [];
  const results: GifResult[] = hits
    .filter((hit: any) => {
      const source = hit.source ?? hit._source ?? {};
      return !isRemovedGif(source);
    })
    .map((hit: any, index: number) => {
      // Debug: log first hit structure
      if (import.meta.env.DEV && index === 0) {
        console.log('First hit structure:', hit);
      }
      const source = hit.source ?? hit._source ?? {};
      return {
        ...source,
        id: hit.id ?? hit._id ?? '',
        score: hit._index_scores?.embeddings ?? hit._score ?? 0,
        gif_url: source.gif_url ?? '',
        description: source.description ?? source.original_description ?? source.combined_text ?? '',
        rank: index + 1,
      };
    });

  return {
    results,
    total: firstResponse?.hits?.total ?? results.length,
  };
}

export async function getRandomGifs(tableName: string, limit: number = 30, excludedAttributions?: Set<string>): Promise<SearchResponse> {
  // Antfly returns docs in insertion order, so a single query from offset 0
  // only gets the most recently ingested source. Instead, fire parallel small
  // queries at random offsets, merge & dedupe, then shuffle.
  const exclusion = buildExclusionQuery([], excludedAttributions);

  // First, get total count with a cheap limit=0 query
  const countBody: Record<string, unknown> = { limit: 0 };
  if (exclusion) countBody.exclusion_query = exclusion;

  const countResp = await fetch(`${API_BASE}/tables/${tableName}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(countBody),
  });
  if (!countResp.ok) throw new Error(`Failed to load GIFs: ${countResp.statusText}`);
  const countData = await countResp.json();
  const total = countData.responses?.[0]?.hits?.total ?? 0;
  if (total === 0) return { results: [], total: 0 };

  // Pick a few random offsets and fetch small batches in parallel
  const batchSize = Math.min(limit * 2, total);
  const numBatches = Math.min(5, Math.ceil(total / batchSize));
  const offsets = Array.from({ length: numBatches }, () =>
    Math.floor(Math.random() * Math.max(1, total - batchSize))
  );

  const fetches = offsets.map(async (offset) => {
    const body: Record<string, unknown> = { limit: batchSize, offset };
    if (exclusion) body.exclusion_query = exclusion;
    const resp = await fetch(`${API_BASE}/tables/${tableName}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.responses?.[0]?.hits?.hits ?? [];
  });

  const batches = await Promise.all(fetches);

  // Merge & dedupe
  const seen = new Set<string>();
  const pool: GifResult[] = [];
  for (const hits of batches) {
    for (const hit of hits) {
      const id = hit._id ?? '';
      if (seen.has(id)) continue;
      seen.add(id);
      const source = hit.source ?? hit._source ?? {};
      if (isRemovedGif(source)) continue;
      pool.push({
        ...source,
        id,
        score: hit._score ?? 1,
        gif_url: source.gif_url ?? '',
        description: source.description ?? source.original_description ?? source.combined_text ?? '',
      });
    }
  }

  // Fisher-Yates shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return {
    results: pool.slice(0, limit),
    total,
  };
}

export interface AttributionBucket {
  key: string;
  count: number;
}

export async function getAttributions(tableName: string): Promise<AttributionBucket[]> {
  const response = await fetch(`${API_BASE}/tables/${tableName}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      limit: 0,
      aggregations: {
        attributions: { type: 'terms', field: 'attribution', size: 50 },
      },
    }),
  });

  if (!response.ok) return [];

  const data = await response.json();
  const buckets = data.responses?.[0]?.aggregations?.attributions?.buckets ?? [];
  return buckets.map((b: any) => ({ key: b.key as string, count: b.doc_count as number }));
}
