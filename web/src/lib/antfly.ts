// Antfly API client for GIF search

const API_BASE = '/api/v1';

// Tags that are globally blocked - GIFs with these tags are hidden from all users
const BLOCKED_TAGS = new Set(['porn']);

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

// Check if GIF has any blocked tags
function hasBlockedTag(source: Record<string, any>): boolean {
  const tags = source.tags;
  if (!Array.isArray(tags)) return false;
  return tags.some(tag => typeof tag === 'string' && BLOCKED_TAGS.has(tag.toLowerCase()));
}

// Google-style query parsing: "quoted phrases", tag:X, -tag:X, and loose terms
interface ParsedQuery {
  phrases: string[];    // "quoted phrases" → match_phrase
  looseText: string;    // unquoted terms → match + semantic
  tags: string[];
  negativeTags: string[];
  ratings: string[];
}

function parseQuery(raw: string): ParsedQuery {
  const tags: string[] = [];
  const negativeTags: string[] = [];
  const ratings: string[] = [];
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
    })
    // rating:"quoted" and rating:word
    .replace(/rating:"([^"]+)"/g, (_, r) => {
      ratings.push(r.toLowerCase());
      return '';
    })
    .replace(/rating:(\S+)/g, (_, r) => {
      ratings.push(r.toLowerCase());
      return '';
    });

  // Extract "quoted phrases"
  remaining = remaining.replace(/"([^"]+)"/g, (_, phrase) => {
    phrases.push(phrase.trim());
    return '';
  });

  const looseText = remaining.trim();
  return { phrases, looseText, tags, negativeTags, ratings };
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

// Build exclusion_query from negative tags and blocked tags
function buildExclusionQuery(negativeTags: string[]): Record<string, unknown> | undefined {
  const parts: string[] = [];

  // Add globally blocked tags
  for (const tag of BLOCKED_TAGS) {
    parts.push(`tags:"${tag}"`);
  }

  // Add user's negative tags
  for (const tag of negativeTags) {
    // Quote values to handle multi-word tags like "Live Leak"
    parts.push(`tags:"${tag}"`);
  }

  if (parts.length === 0) return undefined;
  return { query: parts.join(' OR ') };
}

export async function searchGifs(
  query: string,
  tableName: string,
  limit: number = 50,
): Promise<SearchResponse> {
  const body: Record<string, unknown> = { limit };
  const { phrases, looseText, tags, negativeTags, ratings } = parseQuery(query);

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

  // Build structured filter queries from tag: and rating: prefixes
  const filterParts: Record<string, unknown>[] = [];

  // tag: filters — use match_phrase for multi-word tags (Bleve tokenizes
  // "Live Leak" into ["live","leak"], so term:"live leak" won't match)
  for (const t of tags) {
    filterParts.push(
      t.includes(' ')
        ? { match_phrase: t, field: 'tags' }
        : { term: t, field: 'tags' }
    );
  }

  // rating: filters
  for (const r of ratings) {
    filterParts.push({ term: r, field: 'rating' });
  }

  if (filterParts.length > 0) {
    const filterQuery = filterParts.length === 1 ? filterParts[0] : { conjuncts: filterParts };

    if (hasTextSearch) {
      body.filter_query = filterQuery;
    } else {
      // Filter-only (no text/semantic search): use as primary full-text search
      body.full_text_search = filterQuery;
    }
  }

  // Apply negative tags exclusion
  const exclusion = buildExclusionQuery(negativeTags);
  if (exclusion) {
    body.exclusion_query = exclusion;
  }

  const response = await fetch(`${API_BASE}/tables/${tableName}/query`, {
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
      return !isRemovedGif(source) && !hasBlockedTag(source);
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

const TOTAL_CACHE_KEY = 'honeycomb_gif_total';

export async function getRandomGifs(tableName: string, limit: number = 30): Promise<SearchResponse> {
  const exclusion = buildExclusionQuery([]);

  // Use cached total from localStorage to pick a random offset (0 on first visit)
  const cachedTotal = parseInt(localStorage.getItem(TOTAL_CACHE_KEY) ?? '0', 10);
  const randomOffset = cachedTotal > limit
    ? Math.floor(Math.random() * (cachedTotal - limit))
    : 0;

  const body: Record<string, unknown> = { limit, offset: randomOffset };
  if (exclusion) body.exclusion_query = exclusion;

  const resp = await fetch(`${API_BASE}/tables/${tableName}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Failed to load GIFs: ${resp.statusText}`);

  const data = await resp.json();
  const firstResponse = data.responses?.[0];
  const total = firstResponse?.hits?.total ?? 0;
  const hits = firstResponse?.hits?.hits ?? [];

  // Cache total for future offset calculations and footer display
  if (total > 0) {
    localStorage.setItem(TOTAL_CACHE_KEY, String(total));
  }

  // If stale cache caused offset to overshoot (0 results), retry once at offset 0
  if (hits.length === 0 && randomOffset > 0) {
    const retryBody: Record<string, unknown> = { limit, offset: 0 };
    if (exclusion) retryBody.exclusion_query = exclusion;

    const retryResp = await fetch(`${API_BASE}/tables/${tableName}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(retryBody),
    });
    if (!retryResp.ok) throw new Error(`Failed to load GIFs: ${retryResp.statusText}`);

    const retryData = await retryResp.json();
    const retryFirst = retryData.responses?.[0];
    const retryTotal = retryFirst?.hits?.total ?? 0;
    if (retryTotal > 0) {
      localStorage.setItem(TOTAL_CACHE_KEY, String(retryTotal));
    }
    return buildRandomResponse(retryFirst?.hits?.hits ?? [], retryTotal, limit);
  }

  return buildRandomResponse(hits, total, limit);
}

function buildRandomResponse(hits: any[], total: number, limit: number): SearchResponse {
  const pool: GifResult[] = hits
    .filter((hit: any) => {
      const source = hit.source ?? hit._source ?? {};
      return !isRemovedGif(source) && !hasBlockedTag(source);
    })
    .map((hit: any) => {
      const source = hit.source ?? hit._source ?? {};
      return {
        ...source,
        id: hit.id ?? hit._id ?? '',
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
    total,
  };
}
