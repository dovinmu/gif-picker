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
  tumblr_id: string;
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

export async function searchGifs(
  query: string,
  table: TableConfig,
  limit: number = 50,
): Promise<SearchResponse> {
  let body: Record<string, unknown>;

  if (table.searchMode === 'semantic') {
    // Let Antfly's built-in termite embed the query text
    body = {
      semantic_search: query,
      indexes: ['embeddings'],
      limit,
    };
  } else {
    // Embed query client-side via fixed termite (CLIP with EOS pooling)
    const queryVector = await embedQuery(query);
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
  const results: GifResult[] = hits.map((hit: any, index: number) => {
    // Debug: log first hit structure
    if (import.meta.env.DEV && index === 0) {
      console.log('First hit structure:', hit);
    }
    const source = hit.source ?? hit._source ?? {};
    return {
      id: hit.id ?? hit._id ?? '',
      score: hit._index_scores?.embeddings ?? hit._score ?? 0,
      gif_url: source.gif_url ?? '',
      description: source.description ?? source.original_description ?? source.combined_text ?? '',
      tumblr_id: source.tumblr_id ?? '',
      rank: index + 1,
    };
  });

  return {
    results,
    total: firstResponse?.hits?.total ?? results.length,
  };
}

export async function getRandomGifs(tableName: string, limit: number = 50): Promise<SearchResponse> {
  // Get random GIFs without semantic search (for initial load)
  const response = await fetch(`${API_BASE}/tables/${tableName}/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      limit,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to load GIFs: ${response.statusText}`);
  }

  const data = await response.json();
  const hits = data.responses?.[0]?.hits?.hits ?? [];
  const results: GifResult[] = hits.map((hit: any) => {
    const source = hit.source ?? hit._source ?? {};
    return {
      id: hit._id ?? '',
      score: hit._score ?? 1,
      gif_url: source.gif_url ?? '',
      description: source.description ?? source.original_description ?? source.combined_text ?? '',
      tumblr_id: source.tumblr_id ?? '',
    };
  });

  return {
    results,
    total: data.responses?.[0]?.hits?.total ?? results.length,
  };
}
