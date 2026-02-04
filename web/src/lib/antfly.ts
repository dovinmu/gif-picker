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

// Parse query for tag:X prefixes
function parseQuery(raw: string): { text: string; tags: string[] } {
  const tags: string[] = [];
  const text = raw.replace(/tag:(\S+)/g, (_, tag) => {
    tags.push(tag.toLowerCase());
    return '';
  }).trim();
  return { text, tags };
}

export async function searchGifs(
  query: string,
  table: TableConfig,
  limit: number = 50,
): Promise<SearchResponse> {
  let body: Record<string, unknown>;
  const { text, tags } = parseQuery(query);

  if (table.searchMode === 'semantic') {
    body = { limit };

    if (text) {
      // Run both full-text and semantic search, merge with RRF
      body.full_text_search = { match: text, field: 'combined_text' };
      body.semantic_search = text;
      body.indexes = ['embeddings'];
      body.merge_strategy = 'rrf';
    }

    // Apply tag filter
    if (tags.length === 1) {
      body.filter_query = { term: tags[0], field: 'tags' };
    } else if (tags.length > 1) {
      body.filter_query = {
        conjuncts: tags.map(t => ({ term: t, field: 'tags' })),
      };
    }
  } else {
    // CLIP mode: embed query client-side via fixed termite
    const queryVector = await embedQuery(text || query);
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

export async function getRandomGifs(tableName: string, limit: number = 30): Promise<SearchResponse> {
  // Fetch a larger pool and shuffle client-side for variety on each load
  const poolSize = Math.max(limit * 5, 200);
  const response = await fetch(`${API_BASE}/tables/${tableName}/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      limit: poolSize,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to load GIFs: ${response.statusText}`);
  }

  const data = await response.json();
  const hits = data.responses?.[0]?.hits?.hits ?? [];
  const pool: GifResult[] = hits
    .filter((hit: any) => {
      const source = hit.source ?? hit._source ?? {};
      return !isRemovedGif(source);
    })
    .map((hit: any) => {
      const source = hit.source ?? hit._source ?? {};
      return {
        ...source,
        id: hit._id ?? '',
        score: hit._score ?? 1,
        gif_url: source.gif_url ?? '',
        description: source.description ?? source.original_description ?? source.combined_text ?? '',
      };
    });

  // Fisher-Yates shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  return {
    results: pool.slice(0, limit),
    total: data.responses?.[0]?.hits?.total ?? pool.length,
  };
}
